import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readStoredJob, writeStoredJob } from '../lib/jobhandoff'

/**
 * NewGuideView 的行为测试（拆分前的回归网）。
 *
 * 只测"和拆分有关、且容易在拆分中悄悄改坏"的东西：
 * 1. 提交闸门（canSubmit）的三要素：非 busy、正文 ≥10 字、不在冷却中；
 * 2. 刷新续接：sessionStorage 里有新鲜 job 就接着轮询，超过硬预算就丢弃；
 * 3. 配额展示：hour/day 剩余量来自 /quota，缺失时不崩。
 *
 * 不测样式、不测文案排版——那些由 26 条 E2E 兜。
 */

const mocks = vi.hoisted(() => ({
  getJson: vi.fn(),
  postJson: vi.fn(),
  postForm: vi.fn(),
  push: vi.fn(),
}))

vi.mock('../lib/http', () => ({
  // 签名要与 lib/http 的真实 ApiError 对齐：组件会读 kind / code / retryAfter，
  // 少一个字段，429 冷却那条就永远测不到。
  ApiError: class ApiError extends Error {
    constructor(
      public kind: string,
      public status?: number,
      public code?: string,
      message?: string,
      public ref?: string,
      public retryAfter?: number,
    ) {
      super(message ?? code ?? kind)
      this.name = 'ApiError'
    }
  },
  getJson: mocks.getJson,
  postJson: mocks.postJson,
  postForm: mocks.postForm,
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: mocks.push }),
  RouterLink: { name: 'RouterLink', template: '<a><slot /></a>' },
}))

import NewGuideView from './NewGuideView.vue'
import { ApiError } from '../lib/http'

const QUOTA = {
  hour: { used: 0, limit: 2, reset_in_s: 3600 },
  day: { used: 3, limit: 10, reset_in_s: 86_400 },
  site_budget: { used_micros: 0, limit_micros: 5_000_000, used_cny: 0, limit_cny: 5 },
  queue: { pending: 0, limit: 3 },
}

function mountView() {
  return mount(NewGuideView, {
    global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } },
  })
}

/** 页面上真正那个提交按钮：class 里带 submit 的那个（不是 type=submit）。 */
function submitButton(wrapper: ReturnType<typeof mount>) {
  const btn = wrapper.find('button.submit')
  if (!btn.exists()) throw new Error('没找到提交按钮')
  return btn
}

beforeEach(() => {
  sessionStorage.clear()
  mocks.getJson.mockResolvedValue(QUOTA)
  mocks.postJson.mockReset()
  mocks.push.mockReset()
})

describe('NewGuideView 提交闸门', () => {
  it('组件能挂载（拆分的底线：拆完还得能渲染）', () => {
    const wrapper = mountView()
    expect(wrapper.exists()).toBe(true)
    wrapper.unmount()
  })

  it('正文不足 10 字时提交按钮禁用', async () => {
    const wrapper = mountView()
    await wrapper.find('textarea').setValue('太短了')
    expect(submitButton(wrapper).attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })

  it('正文达到 10 字后提交按钮可用', async () => {
    const wrapper = mountView()
    await wrapper.find('textarea').setValue('客室侧门开关门功能试验')
    expect(submitButton(wrapper).attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })

  it('首尾空白不计入字数', async () => {
    const wrapper = mountView()
    await wrapper.find('textarea').setValue('   短   ')
    expect(submitButton(wrapper).attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })
})

describe('NewGuideView 刷新续接', () => {
  const JOB_ID = 'j_0123456789abcdef'

  it('超过硬预算的 job 直接丢弃，不再等', async () => {
    // HARD_TIMEOUT_MS = 175s 服务端预算 + 5s 客户端宽限
    writeStoredJob(JOB_ID, Date.now() - 200_000)
    const wrapper = mountView()
    await flushPromises()
    expect(readStoredJob()).toBeNull()
    wrapper.unmount()
  })

  it('未超时的 job 会被接着轮询（不是重新提交）', async () => {
    writeStoredJob(JOB_ID, Date.now() - 1_000)
    mocks.getJson.mockImplementation((url: string) => {
      if (url.includes('/quota')) return Promise.resolve(QUOTA)
      return Promise.resolve({ id: JOB_ID, status: 'running', progress: 0 })
    })
    const wrapper = mountView()
    await flushPromises()
    // 恢复不是立刻轮询：onMounted 里是 setTimeout(poll, 300)，先让页面渲染出"接着等"的状态
    await new Promise((r) => setTimeout(r, 350))
    await flushPromises()
    // 关键：恢复走的是查询（GET /jobs/xxx），不是重新发起生成（POST /generate）
    const polledJob = mocks.getJson.mock.calls.some((c) => String(c[0]).includes('/jobs/'))
    expect(polledJob).toBe(true)
    expect(mocks.postJson).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})

/** 造一个只有元数据的假文件：不真的分配 5MB 内存，只让 size 可控。 */
function fakeFile(name: string, type: string, size: number): File {
  const file = new File([new Uint8Array(1)], name, { type })
  Object.defineProperty(file, 'size', { value: size })
  return file
}

function fileInput(wrapper: ReturnType<typeof mount>) {
  const input = wrapper.find('input[type="file"]')
  if (!input.exists()) throw new Error('没找到文件输入')
  return input
}

async function pick(wrapper: ReturnType<typeof mount>, files: File[]) {
  const input = fileInput(wrapper)
  Object.defineProperty(input.element, 'files', { value: files, configurable: true })
  await input.trigger('change')
  await flushPromises()
}

describe('NewGuideView 素材限制', () => {
  beforeEach(() => {
    mocks.postForm.mockReset()
    mocks.postForm.mockResolvedValue({ asset_id: 'a_test', width: 800, height: 600 })
  })

  it('只收 PNG / JPEG / WebP，GIF 直接拒', async () => {
    const wrapper = mountView()
    await pick(wrapper, [fakeFile('a.gif', 'image/gif', 1024)])
    expect(wrapper.text()).toContain('只支持 PNG / JPEG / WebP')
    expect(mocks.postForm).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('单张超过 5MB 被拒', async () => {
    const wrapper = mountView()
    await pick(wrapper, [fakeFile('big.png', 'image/png', 6 * 1024 * 1024)])
    expect(wrapper.text()).toContain('单张不能超过 5 MB')
    expect(mocks.postForm).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('一次选 5 张时只传前 4 张，并告知忽略了几张', async () => {
    const wrapper = mountView()
    await pick(
      wrapper,
      Array.from({ length: 5 }, (_, i) => fakeFile(`p${i}.png`, 'image/png', 1024)),
    )
    expect(mocks.postForm).toHaveBeenCalledTimes(4)
    expect(wrapper.text()).toContain('已忽略多余的 1 张')
    wrapper.unmount()
  })

  it('没有素材时「识别图中内容」按钮禁用', () => {
    const wrapper = mountView()
    const extractBtn = wrapper.findAll('button').find((b) => b.text().includes('识别图中内容'))
    expect(extractBtn).toBeTruthy()
    expect(extractBtn?.attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })
})

describe('NewGuideView 429 冷却', () => {
  it('返回 429 后按钮禁用、文案切到「额度恢复后」，并停止提交', async () => {
    mocks.postJson.mockRejectedValue(
      new ApiError('ratelimit', 429, 'rate_limited', '额度已用完，请稍后再试。', undefined, 30),
    )
    const wrapper = mountView()
    await wrapper.find('textarea').setValue('客室侧门开关门功能试验，检查门锁闭合与指示灯')
    expect(submitButton(wrapper).attributes('disabled')).toBeUndefined()

    await submitButton(wrapper).trigger('click')
    await flushPromises()

    expect(submitButton(wrapper).attributes('disabled')).toBeDefined()
    expect(submitButton(wrapper).text()).toContain('额度恢复后')
    wrapper.unmount()
  })
})
