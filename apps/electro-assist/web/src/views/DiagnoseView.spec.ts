import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiagnoseResponse, KbOverview } from '../types'

/**
 * DiagnoseView（B 模块页面壳）的行为测试。之前是 0 覆盖。
 *
 * 这个文件本身只有 205 行 script、渲染已拆到 QuickResult / StepRun，
 * 所以测的是**编排**：什么时候发请求、发什么、失败了怎么兜。
 * 四条主线：
 * 1. 症状太短不许发起（省一次不该花的检索）；
 * 2. 知识库概览只是提示，取不到不能拦住主流程；
 * 3. **A1 转入**：query 带 symptom 就自动查，并且把 guide/step 带进 context
 *    （不带的话 B 的结论回写不到作业记录，报告里那栏永远是空的）；
 * 4. 流式没给出最终结果时，回退到一次性 JSON（老内核/代理吞帧的兜底）。
 */

const mocks = vi.hoisted(() => ({
  getJson: vi.fn(),
  postJson: vi.fn(),
  postStream: vi.fn(),
  announce: vi.fn(),
  route: { query: {} as Record<string, string> },
  startDiagnosis: vi.fn(),
  submitDiagnosis: vi.fn(),
  abortDiagnosis: vi.fn(),
  resetDiagnosis: vi.fn(),
}))

vi.mock('../lib/http', () => ({
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
}))
vi.mock('../lib/sse', () => ({ postStream: mocks.postStream }))
vi.mock('../lib/announce', () => ({ announce: mocks.announce }))
vi.mock('vue-router', () => ({ useRoute: () => mocks.route }))
vi.mock('../composables/useDiagnoseRun', async () => {
  const { ref } = await import('vue')
  return {
    useDiagnoseRun: () => ({
      runData: ref(null),
      busy: ref(false),
      error: ref(''),
      start: mocks.startDiagnosis,
      submit: mocks.submitDiagnosis,
      abort: mocks.abortDiagnosis,
      reset: mocks.resetDiagnosis,
    }),
  }
})

import DiagnoseView from './DiagnoseView.vue'

const KB: KbOverview = {
  version: '1.0',
  provider: 'hybrid',
  systems: ['door', 'hvac'],
  count: 18,
  entries: [],
}

const HIT: DiagnoseResponse = {
  query: '门关到一半又弹开',
  matched: true,
  uncovered_reason: null,
  message: '',
  suggestion: '检查门锁闭锁开关',
  results: [],
  count: 2,
  confidence: 0.47,
  took_ms: 120,
  kb_version: '1.0',
  disclaimer: '结论仅供参考，须由专业人员确认',
}

function mountView() {
  return mount(DiagnoseView, {
    global: { stubs: { QuickResult: true, StepRun: true, ThemeNoticeBar: true } },
  })
}

function clickButton(wrapper: ReturnType<typeof mount>, text: string) {
  const btn = wrapper.findAll('button').find((b) => b.text().includes(text))
  if (!btn) throw new Error(`没找到按钮：${text}`)
  return btn
}

beforeEach(() => {
  Object.values(mocks).forEach((fn) => {
    if (typeof fn === 'function' && 'mockReset' in fn) fn.mockReset()
  })
  mocks.route.query = {}
  mocks.getJson.mockResolvedValue(KB)
  mocks.startDiagnosis.mockResolvedValue(true)
})

describe('DiagnoseView 前置校验与知识库概览', () => {
  it('症状不足 4 个字时按钮禁用，不发起请求', async () => {
    const wrapper = mountView()
    await flushPromises()

    await wrapper.find('#symptom').setValue('门坏')
    const btn = clickButton(wrapper, '开始排查')
    expect(btn.attributes('disabled')).toBeDefined()
    expect(mocks.postStream).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('知识库概览按中文子系统名渲染', async () => {
    const wrapper = mountView()
    await flushPromises()

    expect(wrapper.text()).toContain('知识库 18 条')
    // door/hvac 要翻成中文，不能把英文 key 摊给现场
    expect(wrapper.text()).toContain('客室侧门、空调')
    expect(wrapper.text()).toContain('关键词 + 向量混合召回')
    wrapper.unmount()
  })

  it('概览取不到时不显示，也不影响输入与提交', async () => {
    mocks.getJson.mockRejectedValue(new Error('kb down'))
    mocks.postStream.mockResolvedValue(undefined)
    mocks.postJson.mockResolvedValue(HIT)
    const wrapper = mountView()
    await flushPromises()

    expect(wrapper.text()).not.toContain('知识库')
    // 关键：kb 挂掉不该让页面变成错误态
    await wrapper.find('#symptom').setValue('门关到一半又弹开')
    expect(clickButton(wrapper, '开始排查').attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })
})

describe('DiagnoseView 从 A1 转入', () => {
  it('query 带 symptom 时自动发起排查，并把 guide/step 带进 context', async () => {
    mocks.route.query = { symptom: '门关到一半又弹开', guide: 'g_1', step: '3' }
    mocks.postStream.mockResolvedValue(undefined)
    mocks.postJson.mockResolvedValue(HIT)

    const wrapper = mountView()
    await flushPromises()

    expect(mocks.postStream).toHaveBeenCalled()
    const body = mocks.postStream.mock.calls[0]![1]
    expect(body.symptom).toBe('门关到一半又弹开')
    // 不带 context 的话，B 的结论回写不到作业记录——报告里那块永远是空的
    expect(body.context).toEqual({ guide_id: 'g_1', step_seq: 3 })
    wrapper.unmount()
  })

  it('页面上标明"来自作业记录"，让人知道自己还在某次作业里', async () => {
    mocks.route.query = { symptom: '门关到一半又弹开', guide: 'g_1', step: '3' }
    mocks.postStream.mockResolvedValue(undefined)
    mocks.postJson.mockResolvedValue(HIT)

    const wrapper = mountView()
    await flushPromises()

    expect(wrapper.text()).toContain('来自作业记录')
    expect(wrapper.text()).toContain('第 3 步异常')
    wrapper.unmount()
  })

  it('非法 sid 被丢弃，不会带进逐步诊断', async () => {
    // 合法形状是 s_ + 16 位十六进制；带错的话后端会 404 或挂错会话
    mocks.route.query = { symptom: '门关到一半又弹开', sid: 'garbage' }
    const wrapper = mountView()
    await flushPromises()

    // 切到逐步诊断并发起，看 start 的第 4 个参数（sessionId）
    await wrapper.findAll('.mode__btn')[1]!.trigger('click')
    await clickButton(wrapper, '开始逐步诊断').trigger('click')
    await flushPromises()

    const call = mocks.startDiagnosis.mock.calls[0]!
    expect(call[3]).toBe('')
    wrapper.unmount()
  })
})

describe('DiagnoseView 快速检索：流式与回退', () => {
  it('recall 事件先让候选上屏，阶段文案跟着变', async () => {
    let release: (() => void) | undefined
    mocks.postStream.mockImplementation(
      (_url: string, _body: unknown, opts: { onEvent: (e: string, d: unknown) => void }) => {
        opts.onEvent('recall', { candidates: [{ id: 'k1', title: '门锁闭锁开关故障', score: 9 }] })
        return new Promise<void>((res) => {
          release = res
        })
      },
    )
    const wrapper = mountView()
    await flushPromises()

    await wrapper.find('#symptom').setValue('门关到一半又弹开')
    void clickButton(wrapper, '开始排查').trigger('click')
    await flushPromises()

    // 候选先上屏，用户不用等重排跑完
    expect(wrapper.text()).toContain('门锁闭锁开关故障')
    expect(wrapper.text()).toContain('正在按可能性排序')
    release?.()
    await flushPromises()
    wrapper.unmount()
  })

  it('流给出 done 时直接用流的结果，不再补发一次性请求', async () => {
    mocks.postStream.mockImplementation(
      (_url: string, _body: unknown, opts: { onEvent: (e: string, d: unknown) => void }) => {
        opts.onEvent('recall', { candidates: [] })
        opts.onEvent('done', HIT)
        return Promise.resolve()
      },
    )
    const wrapper = mountView()
    await flushPromises()

    await wrapper.find('#symptom').setValue('门关到一半又弹开')
    await clickButton(wrapper, '开始排查').trigger('click')
    await flushPromises()

    expect(mocks.postJson).not.toHaveBeenCalled()
    expect(wrapper.find('quick-result-stub').exists()).toBe(true)
    wrapper.unmount()
  })

  it('流没给出最终结果时回退到一次性 JSON（老内核 / 代理吞帧的兜底）', async () => {
    // 只发 recall 不发 done：模拟流被中间设备吞掉最后一帧
    mocks.postStream.mockImplementation(
      (_url: string, _body: unknown, opts: { onEvent: (e: string, d: unknown) => void }) => {
        opts.onEvent('recall', { candidates: [] })
        return Promise.resolve()
      },
    )
    mocks.postJson.mockResolvedValue(HIT)
    const wrapper = mountView()
    await flushPromises()

    await wrapper.find('#symptom').setValue('门关到一半又弹开')
    await clickButton(wrapper, '开始排查').trigger('click')
    await flushPromises()

    expect(mocks.postJson).toHaveBeenCalled()
    expect(wrapper.find('quick-result-stub').exists()).toBe(true)
    wrapper.unmount()
  })
})

describe('DiagnoseView 模式切换', () => {
  it('切到逐步诊断会清掉快速检索的结果，避免两套结果同时在页面上', async () => {
    mocks.postStream.mockResolvedValue(undefined)
    mocks.postJson.mockResolvedValue(HIT)
    const wrapper = mountView()
    await flushPromises()

    await wrapper.find('#symptom').setValue('门关到一半又弹开')
    await clickButton(wrapper, '开始排查').trigger('click')
    await flushPromises()
    expect(wrapper.find('quick-result-stub').exists()).toBe(true)

    await wrapper.findAll('.mode__btn')[1]!.trigger('click')
    await flushPromises()

    expect(wrapper.find('quick-result-stub').exists()).toBe(false)
    expect(wrapper.find('step-run-stub').exists()).toBe(true)
    expect(mocks.resetDiagnosis).toHaveBeenCalled()
    wrapper.unmount()
  })
})
