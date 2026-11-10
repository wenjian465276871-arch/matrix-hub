import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GuideDetail } from '../types'

/**
 * GuideView 的行为测试（拆它之前的回归网）。
 *
 * GuideView 比 NewGuideView 更难测：它有 props、要跑 load()、依赖 router 与三种
 * 网络动词（getJson / patchJson / putJson / postJson）。这里只锁三件与拆分强相关、
 * 且容易改坏的事：
 * 1. 加载成功要把标题、步骤、素材数量渲染出来；
 * 2. 404 与其它错误要分开处理（一个说"找不到"，一个说"服务不可用"）；
 * 3. 草稿态 + 步骤缺判据时，发布缺口要**在页面上提前算出来**，而不是等点发布才报错
 *    （这条是 `publish_blockers` 的前端镜像，拆组件时最容易被顺手改掉）。
 */

const mocks = vi.hoisted(() => ({
  getJson: vi.fn(),
  patchJson: vi.fn(),
  postJson: vi.fn(),
  putJson: vi.fn(),
  push: vi.fn(),
  writeStoredJob: vi.fn(),
  announce: vi.fn(),
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
  patchJson: mocks.patchJson,
  postJson: mocks.postJson,
  putJson: mocks.putJson,
}))

vi.mock('vue-router', () => ({ useRouter: () => ({ push: mocks.push }) }))
vi.mock('../lib/announce', () => ({ announce: mocks.announce }))
vi.mock('../lib/jobhandoff', () => ({ writeStoredJob: mocks.writeStoredJob }))

import GuideView from './GuideView.vue'
import { ApiError } from '../lib/http'

function detail(overrides: Partial<GuideDetail['guide']> = {}, status: 'draft' | 'published' = 'draft') {
  const base: GuideDetail = {
    status,
    process_id: null,
    guide: {
      schema_version: '1.2',
      id: 'g_test',
      title: '客室侧门开关门功能试验',
      summary: '测试用摘要',
      meta: {
        system: 'door',
        source_note: '测试',
        model: 'test-model',
        generated_at: '2026-11-06T00:00:00Z',
        is_demo: true,
      },
      steps: [
        {
          id: 's1',
          seq: 1,
          title: '检查门锁闭合',
          action: '手动关闭车门，观察锁扣',
          safety: [],
          tools: [],
          criteria: [],
          figures: [],
          assets: [],
          duration_s: null,
        },
      ],
      assets: [],
      disclaimers: [],
    },
  }
  return { ...base, guide: { ...base.guide, ...overrides } }
}

function mountView() {
  return mount(GuideView, {
    props: { id: 'g_test' },
    global: {
      // 图形与确认弹层不是本文件要验的东西，stub 掉省得引入 SVG 与 Teleport 噪音；
      // RouterLink 也 stub：本文件的 vue-router mock 只提供了 useRouter
      stubs: { GuideFigure: true, ConfirmDialog: true, RouterLink: true },
    },
  })
}

beforeEach(() => {
  sessionStorage.clear()
  Object.values(mocks).forEach((fn) => fn.mockReset())
})

describe('GuideView 加载', () => {
  it('加载成功后渲染标题与步骤', async () => {
    mocks.getJson.mockResolvedValue(detail())
    const wrapper = mountView()
    await flushPromises()

    expect(wrapper.text()).toContain('客室侧门开关门功能试验')
    expect(wrapper.text()).toContain('检查门锁闭合')
    wrapper.unmount()
  })

  it('404 走「找不到」，而不是笼统的服务错误', async () => {
    mocks.getJson.mockRejectedValue(new ApiError('notfound', 404, 'not_found'))
    const wrapper = mountView()
    await flushPromises()

    expect(wrapper.text()).toContain('这份指导书不存在')
    // 不应该同时出现"服务暂不可用"，两个分支必须互斥
    expect(wrapper.text()).not.toContain('服务暂不可用')
    wrapper.unmount()
  })

  it('服务错误走「不可用」，并带上状态码', async () => {
    mocks.getJson.mockRejectedValue(new ApiError('server', 503, 'unavailable'))
    const wrapper = mountView()
    await flushPromises()

    expect(wrapper.text()).toContain('服务暂不可用')
    expect(wrapper.text()).toContain('503')
    wrapper.unmount()
  })
})

describe('GuideView 顶栏翻页', () => {
  function twoSteps() {
    const first = detail().guide.steps[0]
    return {
      steps: [
        first,
        { ...first, id: 's2', seq: 2, title: '测量关门时间' },
      ],
    }
  }

  it('点「下一页」页码与正文一起走', async () => {
    mocks.getJson.mockResolvedValue(detail(twoSteps(), 'published'))
    const wrapper = mountView()
    await flushPromises()

    // 封面 + 2 步 = 3 页，起始在封面
    expect(wrapper.get('.pager__count').text().replace(/\s+/g, '')).toBe('1/3')
    await wrapper.get('button[aria-label="下一页"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('.pager__count').text().replace(/\s+/g, '')).toBe('2/3')
    // 第 2 页是第 1 步：正文要跟着换，不能只换页码
    expect(wrapper.findAll('.step__title').map((n) => n.text())).toContain('检查门锁闭合')
    wrapper.unmount()
  })

  it('页码控件的读屏名称用步骤标题，不是"第 N 个点"', async () => {
    mocks.getJson.mockResolvedValue(detail(twoSteps(), 'published'))
    const wrapper = mountView()
    await flushPromises()

    const labels = wrapper.findAll('.pager__dot').map((n) => n.attributes('aria-label'))
    expect(labels[0]).toBe('封面')
    expect(labels[1]).toContain('检查门锁闭合')
    wrapper.unmount()
  })
})

describe('GuideView 发布缺口（publish_blockers 的前端镜像）', () => {
  it('草稿里步骤缺验收判据时，页面上提前显示缺口', async () => {
    mocks.getJson.mockResolvedValue(detail())
    const wrapper = mountView()
    await flushPromises()

    // 后端规则：每步都要有验收判据。前端在 load 时就该把缺口摆出来
    expect(wrapper.text()).toContain('没有验收判据')
    wrapper.unmount()
  })

  it('已发布的不再显示发布缺口', async () => {
    mocks.getJson.mockResolvedValue(detail({}, 'published'))
    const wrapper = mountView()
    await flushPromises()

    expect(wrapper.text()).not.toContain('没有验收判据')
    wrapper.unmount()
  })
})

describe('GuideView 草稿修正（已拆到 EditPanel）', () => {
  const TOKEN_KEY = 'electro-passcode-token'

  function clickButton(wrapper: ReturnType<typeof mount>, text: string) {
    const btn = wrapper.findAll('button').find((b) => b.text().includes(text))
    if (!btn) throw new Error(`没找到按钮：${text}`)
    return btn
  }

  it('没有令牌时先要口令，不直接进编辑态', async () => {
    mocks.getJson.mockResolvedValue(detail())
    const wrapper = mountView()
    await flushPromises()

    await clickButton(wrapper, '修正内容').trigger('click')
    await flushPromises()

    // 提示里本身就含"修正草稿"四个字，所以不能用文本判断，要看编辑面板的特征输入框
    expect(wrapper.find('#edit-title').exists()).toBe(false)
    expect(wrapper.text()).toContain('修正草稿需要口令')
    wrapper.unmount()
  })

  it('有令牌时进入编辑态，改标题保存只发 title', async () => {
    sessionStorage.setItem(TOKEN_KEY, 'tok-1')
    mocks.getJson.mockResolvedValue(detail())
    mocks.patchJson.mockResolvedValue({
      status: 'draft',
      guide_id: 'g_test',
      guide: detail().guide,
      blockers: [],
    })
    const wrapper = mountView()
    await flushPromises()

    await clickButton(wrapper, '修正内容').trigger('click')
    await flushPromises()
    expect(wrapper.find('#edit-title').exists()).toBe(true)

    await wrapper.find('#edit-title').setValue('客室侧门开关门功能试验（修订）')
    await clickButton(wrapper, '保存修正').trigger('click')
    await flushPromises()

    const call = mocks.patchJson.mock.calls[0]
    expect(String(call[0])).toContain('/api/electro/guides/g_test')
    // 只发改动字段：steps 整个不出现，否则后端会重写无关步骤
    expect(call[1]).toEqual({ title: '客室侧门开关门功能试验（修订）' })
    expect(call[2].headers['X-Passcode-Token']).toBe('tok-1')

    // 保存后退出编辑态，提示挂在控制条上（所以它必须由父组件持有）
    expect(wrapper.find('#edit-title').exists()).toBe(false)
    expect(wrapper.text()).toContain('已保存')
    wrapper.unmount()
  })

  it('一个字都没改就保存，提示「没有改动」且不发请求', async () => {
    sessionStorage.setItem(TOKEN_KEY, 'tok-1')
    mocks.getJson.mockResolvedValue(detail())
    const wrapper = mountView()
    await flushPromises()

    await clickButton(wrapper, '修正内容').trigger('click')
    await flushPromises()
    await clickButton(wrapper, '保存修正').trigger('click')
    await flushPromises()

    expect(mocks.patchJson).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('没有改动')
    expect(wrapper.find('#edit-title').exists()).toBe(false)
    wrapper.unmount()
  })

  it('保存返回 401 时清掉本地令牌并重新要口令', async () => {
    sessionStorage.setItem(TOKEN_KEY, 'tok-expired')
    mocks.getJson.mockResolvedValue(detail())
    // 真实 http.ts 里 401 归为 server（只有 429 是 ratelimit），按真实形状构造
    mocks.patchJson.mockRejectedValue(new ApiError('server', 401, 'passcode_required'))
    const wrapper = mountView()
    await flushPromises()

    await clickButton(wrapper, '修正内容').trigger('click')
    await flushPromises()
    await wrapper.find('#edit-title').setValue('改个标题触发保存')
    await clickButton(wrapper, '保存修正').trigger('click')
    await flushPromises()

    // 令牌必须真被丢掉，否则下一次保存还是拿同一个废令牌去撞
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull()
    expect(wrapper.text()).toContain('令牌已过期')
    wrapper.unmount()
  })
})

describe('GuideView 素材归位（已拆到 AttachPanel）', () => {
  const WITH_ASSET = { assets: [{ asset_id: 'a1', caption: '门锁照片' }] }

  it('草稿且有素材时渲染归位面板，保存会把 step_id 带上', async () => {
    mocks.getJson.mockResolvedValue(detail(WITH_ASSET))
    mocks.putJson.mockResolvedValue({
      status: 'draft',
      guide_id: 'g_test',
      attached: 1,
      loose: 0,
    })
    const wrapper = mountView()
    await flushPromises()

    expect(wrapper.text()).toContain('素材归位')
    expect(wrapper.text()).toContain('门锁照片')

    // 选"第 1 步"，再保存
    await wrapper.find('select.attach__select').setValue('s1')
    const saveBtn = wrapper.findAll('button').find((b) => b.text().includes('保存归位'))
    expect(saveBtn).toBeTruthy()
    await saveBtn!.trigger('click')
    await flushPromises()

    const call = mocks.putJson.mock.calls[0]
    expect(String(call[0])).toContain('/assets')
    expect(call[1].assets[0]).toMatchObject({ asset_id: 'a1', step_id: 's1' })
    expect(wrapper.text()).toContain('已保存')
    wrapper.unmount()
  })

  it('已发布锁定（published_locked）时给出明确原因，不是笼统失败', async () => {
    mocks.getJson.mockResolvedValue(detail(WITH_ASSET))
    mocks.putJson.mockRejectedValue(new ApiError('server', 409, 'published_locked'))
    const wrapper = mountView()
    await flushPromises()

    const saveBtn = wrapper.findAll('button').find((b) => b.text().includes('保存归位'))
    await saveBtn!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('已发布的指导书不能调整素材')
    wrapper.unmount()
  })
})

describe('判据来源标记', () => {
  /**
   * 来源标记只在服务端定位到原文时出现。
   *
   * 为什么值得单独测：它是"这个数值不是编的"唯一可见证据。渲染条件写反
   * （比如 `v-if="!c.provenance"`）不会有任何别的测试变红，线上表现是
   * **每条判据都显示"有据"**——比不显示更糟，等于给假数据盖章。
   */
  it('有 provenance 显示「有据 · 第 N 行」，没有则不渲染标记', async () => {
    mocks.getJson.mockResolvedValue(
      detail({
        steps: [
          {
            id: 's1',
            seq: 1,
            title: '检查门锁闭合',
            action: '手动关闭车门，观察锁扣',
            safety: [],
            tools: [],
            criteria: [
              {
                id: 'c_lock_time',
                label: '关门时间',
                type: 'range' as const,
                unit: 's',
                min: 2,
                max: 3.5,
                provenance: {
                  asset_id: null,
                  line: 2,
                  raw_text: '关门时间 2.0–3.5s',
                  flag: 'ok' as const,
                },
              },
              {
                id: 'c_visual',
                label: '目视确认',
                type: 'manual' as const,
              },
            ],
            figures: [],
            assets: [],
            duration_s: null,
          },
        ],
      }),
    )

    const wrapper = mountView()
    await flushPromises()

    const marks = wrapper.findAll('.criterion__src')
    // 两条判据只该有一条标记：没有 provenance 的那条不许出现"无据"占位
    expect(marks).toHaveLength(1)
    expect(marks[0].text()).toBe('有据 · 第 3 行')
    expect(marks[0].classes()).toContain('criterion__src--ok')
    expect(marks[0].attributes('title')).toContain('2.0–3.5s')
    wrapper.unmount()
  })

  it('suspect 显示「待核」，不能被渲染成 ok', async () => {
    mocks.getJson.mockResolvedValue(
      detail({
        steps: [
          {
            id: 's1',
            seq: 1,
            title: '检查门锁闭合',
            action: '手动关闭车门，观察锁扣',
            safety: [],
            tools: [],
            criteria: [
              {
                id: 'c_lock_time',
                label: '关门时间',
                type: 'range' as const,
                unit: 's',
                min: 2,
                max: 3.5,
                provenance: { asset_id: null, line: 0, raw_text: '参考行', flag: 'suspect' as const },
              },
            ],
            figures: [],
            assets: [],
            duration_s: null,
          },
        ],
      }),
    )

    const wrapper = mountView()
    await flushPromises()

    const mark = wrapper.get('.criterion__src')
    expect(mark.text()).toBe('待核 · 第 1 行')
    expect(mark.classes()).toContain('criterion__src--suspect')
    wrapper.unmount()
  })
})

describe('生成期降级提示', () => {
  it('repairs 非空时列出每一条，并说明可以再生成', async () => {
    mocks.getJson.mockResolvedValue({
      ...detail(),
      repairs: ['s04 的图示不合法，已去掉', 'steps.2 仪表无 value，动效已去掉'],
    })
    const wrapper = mountView()
    await flushPromises()

    expect(wrapper.text()).toContain('本次生成有 2 处图示被移除')
    expect(wrapper.text()).toContain('s04 的图示不合法，已去掉')
    expect(wrapper.text()).toContain('再生成一份草稿')
    wrapper.unmount()
  })

  it('repairs 为空时不出提示条', async () => {
    mocks.getJson.mockResolvedValue({ ...detail(), repairs: [] })
    const wrapper = mountView()
    await flushPromises()

    expect(wrapper.text()).not.toContain('处图示被移除')
    wrapper.unmount()
  })

  it('字段缺失（历史数据）也不出错', async () => {
    // 老接口不返回 repairs。前端必须按"没有降级"处理，而不是抛 undefined 访问。
    mocks.getJson.mockResolvedValue(detail())
    const wrapper = mountView()
    await flushPromises()

    expect(wrapper.text()).not.toContain('处图示被移除')
    wrapper.unmount()
  })
})
