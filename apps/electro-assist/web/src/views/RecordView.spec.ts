import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionReport } from '../types'

/**
 * RecordView（作业记录页）的行为测试。之前是 0 覆盖。
 *
 * 这一页是"事后追溯"的唯一入口：出了事故要按它复现过程，所以三块内容是硬需求——
 * 逐步记录（谁在什么时候填了什么）、异常链（哪一步失败过几次）、
 * **关联排查结论**（A1 转 B 之后的结论有没有回写进来）。
 * 最后这块最容易断：断链时页面不报错，只是那一栏悄悄消失。
 */

const mocks = vi.hoisted(() => ({
  getJson: vi.fn(),
  push: vi.fn(),
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
}))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: mocks.push }) }))

import RecordView from './RecordView.vue'
import { ApiError } from '../lib/http'

function report(over: Partial<SessionReport> = {}): SessionReport {
  const base: SessionReport = {
    session: {
      id: 's1',
      guide_id: 'g1',
      status: 'done',
      current_seq: 3,
      device: 'CR400AF',
      location: '客室',
      note: '',
      created_at: '2026-11-06T00:00:00Z',
      updated_at: '2026-11-06T00:10:00Z',
      finished_at: '2026-11-06T00:10:00Z',
    },
    guide: {
      schema_version: '1.2',
      id: 'g1',
      title: '客室侧门开关门功能试验',
      summary: '',
      meta: {
        system: 'door',
        source_note: '测试',
        model: 'test-model',
        generated_at: '2026-11-06T00:00:00Z',
        is_demo: true,
      },
      steps: [],
      assets: [],
      disclaimers: [],
    },
    steps: [
      {
        seq: 1,
        step_id: 's1',
        title: '检查门锁闭合',
        attempts: [
          {
            id: 'r1',
            session_id: 's1',
            step_id: 's1',
            seq: 1,
            attempt: 1,
            verdict: 'pass',
            payload: {
              results: [
                {
                  criterion_id: 'c1',
                  label: '门锁间隙',
                  type: 'range',
                  value: 3,
                  unit: 'mm',
                  verdict: 'pass',
                  message: '',
                },
              ],
            },
            created_at: '2026-11-06T00:02:00Z',
          },
        ],
        final_verdict: 'pass',
        started_at: '2026-11-06T00:01:00Z',
        ended_at: '2026-11-06T00:02:00Z',
        duration_s: 60,
      },
    ],
    exceptions: [],
    diagnoses: [],
    summary: {
      status: 'done',
      total_steps: 1,
      recorded_steps: 1,
      attempts: 1,
      pass: 1,
      manual: 0,
      fail: 0,
      warn: 0,
      aborted: false,
      duration_s: 600,
    },
  }
  return { ...base, ...over }
}

function mountView() {
  // vue-router 只 mock 了 useRouter，RouterLink 要单独 stub；
  // 用渲染 slot 的版本（不是 `true`），否则链接内的内容整个消失、测出来是空壳。
  return mount(RecordView, {
    props: { sid: 's1' },
    global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } },
  })
}

beforeEach(() => {
  Object.values(mocks).forEach((fn) => fn.mockReset())
})

describe('RecordView 载入', () => {
  it('渲染标题、状态与逐步记录', async () => {
    mocks.getJson.mockResolvedValue(report())
    const wrapper = mountView()
    await flushPromises()

    expect(wrapper.text()).toContain('客室侧门开关门功能试验')
    expect(wrapper.text()).toContain('已完成')
    expect(wrapper.text()).toContain('检查门锁闭合')
    expect(wrapper.text()).toContain('10 分 0 秒')
    wrapper.unmount()
  })

  it('404 与其它错误分开说，不混成一句笼统提示', async () => {
    mocks.getJson.mockRejectedValue(new ApiError('notfound', 404, 'not_found'))
    const wrapper = mountView()
    await flushPromises()

    expect(wrapper.text()).toContain('这份记录不存在或已失效')
    wrapper.unmount()
  })

  it('服务错误走「无法载入记录」', async () => {
    mocks.getJson.mockRejectedValue(new ApiError('server', 503, 'unavailable'))
    const wrapper = mountView()
    await flushPromises()

    expect(wrapper.text()).toContain('无法载入记录')
    wrapper.unmount()
  })
})

describe('RecordView 三步内容', () => {
  it('没有异常时明确说「没有」，而不是留一片空白', async () => {
    mocks.getJson.mockResolvedValue(report())
    const wrapper = mountView()
    await flushPromises()

    // 空白会让人以为是页面没加载完
    expect(wrapper.text()).toContain('本次作业没有异常记录')
    wrapper.unmount()
  })

  it('异常链显示第几步、第几次以及具体消息', async () => {
    mocks.getJson.mockResolvedValue(
      report({
        exceptions: [
          {
            seq: 2,
            step_id: 's2',
            attempt: 2,
            verdict: 'fail',
            messages: ['门锁间隙超出上限 5 mm'],
            note: '已复测一次',
            created_at: '2026-11-06T00:05:00Z',
          },
        ],
      }),
    )
    const wrapper = mountView()
    await flushPromises()

    expect(wrapper.text()).toContain('第 2 步 · 第 2 次')
    expect(wrapper.text()).toContain('门锁间隙超出上限 5 mm')
    expect(wrapper.text()).toContain('已复测一次')
    wrapper.unmount()
  })

  it('没执行过的步骤写明「未执行」，不能看着像通过', async () => {
    const data = report()
    data.steps.push({
      seq: 2,
      step_id: 's2',
      title: '检查指示灯',
      attempts: [],
      final_verdict: 'skipped',
      started_at: null,
      ended_at: null,
      duration_s: null,
    })
    mocks.getJson.mockResolvedValue(data)
    const wrapper = mountView()
    await flushPromises()

    expect(wrapper.text()).toContain('检查指示灯')
    expect(wrapper.text()).toContain('未执行')
    // 未执行的步骤不显示耗时
    expect(wrapper.text()).not.toContain('耗时 —')
    wrapper.unmount()
  })

  it('关联排查结论栏只在有结论时出现，状态翻成中文', async () => {
    mocks.getJson.mockResolvedValue(report())
    const wrapper = mountView()
    await flushPromises()
    // 没有排查记录时整栏都不该出现（它不属于"本次作业做了什么"）
    expect(wrapper.text()).not.toContain('关联排查结论')
    wrapper.unmount()

    mocks.getJson.mockResolvedValue(
      report({
        diagnoses: [
          {
            id: 'd1',
            symptom: '门关到一半又弹开',
            system: 'door',
            status: 'concluded',
            current_order: null,
            conclusion: {
              kind: 'fail',
              check_order: 2,
              cause: '门锁闭锁开关接触不良',
              action: '更换闭锁开关',
              safety: '断电后操作',
              sources: ['kb-door-lock-01'],
              confidence: 0.8,
            },
            created_at: '2026-11-06T00:06:00Z',
            finished_at: '2026-11-06T00:08:00Z',
            checks: 3,
          },
        ],
      }),
    )
    const second = mountView()
    await flushPromises()

    expect(second.text()).toContain('关联排查结论')
    expect(second.text()).toContain('门关到一半又弹开')
    // 状态不能把 concluded 直接摊给用户看
    expect(second.text()).toContain('已出结论')
    expect(second.text()).toContain('3 项检查')
    second.unmount()
  })
})
