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
