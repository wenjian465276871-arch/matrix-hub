import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Criterion, SessionSnapshot, Step, StepSubmitResponse } from '../types'

/**
 * RunView 的行为测试（A1 引导主界面，之前是 0 覆盖）。
 *
 * 这一屏是"现场照着做"的地方，出错代价最高。锁住五件事：
 * 1. 载入后把步骤与判据渲染出来；
 * 2. 缺项时**不发请求**、直接指出缺哪几项（现场最烦"提交了才知道没填"）；
 * 3. 提交通过 → 显示结论与「继续下一步」；
 * 4. 提交异常 → 三条出路都在（复测 / 转排查 / 停止），少一条现场就卡死；
 * 5. 超差只改按钮文案、不阻断（计划 §12.4）。
 */

const mocks = vi.hoisted(() => ({
  getJson: vi.fn(),
  postJson: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
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
  postJson: mocks.postJson,
}))

vi.mock('vue-router', () => ({ useRouter: () => ({ push: mocks.push, replace: mocks.replace }) }))
vi.mock('../lib/announce', () => ({ announce: mocks.announce }))
// 软键盘监听在 happy-dom 里没有 visualViewport，直接给个 noop 的清理函数
vi.mock('../lib/viewport', () => ({ watchKeyboardInset: () => () => {} }))

import RunView from './RunView.vue'

function crit(over: Partial<Criterion> = {}): Criterion {
  return {
    id: 'c1',
    label: '门锁间隙',
    type: 'range',
    unit: 'mm',
    min: 2,
    max: 5,
    options: null,
    ...over,
  }
}

function step(criteria: Criterion[] = [crit()]): Step {
  return {
    id: 's1',
    seq: 1,
    title: '检查门锁闭合',
    action: '手动关闭车门，观察锁扣',
    safety: [],
    tools: [],
    criteria,
    figures: [],
    assets: [],
    duration_s: null,
  }
}

function snapshot(steps: Step[] = [step()]): SessionSnapshot {
  return {
    session: {
      id: 's1',
      guide_id: 'g1',
      status: 'active',
      current_seq: 1,
      device: '',
      location: '',
      note: '',
      created_at: '2026-11-06T00:00:00Z',
      updated_at: '2026-11-06T00:00:00Z',
      finished_at: null,
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
      steps,
      assets: [],
      disclaimers: [],
    },
    records: [],
    progress: { total_steps: steps.length, recorded_steps: 0, attempts: 0, current_seq: 1 },
  }
}

function submitResponse(verdict: 'pass' | 'fail' | 'warn', nextSeq = 2): StepSubmitResponse {
  return {
    record: {
      id: 'r1',
      session_id: 's1',
      step_id: 's1',
      seq: 1,
      attempt: 1,
      verdict,
      payload: {},
      created_at: '2026-11-06T00:00:00Z',
    },
    session: {
      id: 's1',
      guide_id: 'g1',
      status: 'active',
      current_seq: nextSeq,
      device: '',
      location: '',
      note: '',
      created_at: '2026-11-06T00:00:00Z',
      updated_at: '2026-11-06T00:00:00Z',
      finished_at: null,
    },
    verdict,
    results: [
      {
        criterion_id: 'c1',
        label: '门锁间隙',
        type: 'range',
        value: 3,
        unit: 'mm',
        verdict,
        message: verdict === 'pass' ? '' : '超出范围',
      },
    ],
    messages: [],
    duplicate: false,
  }
}

function mountView() {
  return mount(RunView, {
    props: { sid: 's1' },
    global: {
      stubs: { GuideFigure: true, ConfirmDialog: true, ThemeNoticeBar: true },
    },
  })
}

function clickButton(wrapper: ReturnType<typeof mount>, text: string) {
  const btn = wrapper.findAll('button').find((b) => b.text().includes(text))
  if (!btn) throw new Error(`没找到按钮：${text}`)
  return btn
}

beforeEach(() => {
  Object.values(mocks).forEach((fn) => fn.mockReset())
})

describe('RunView 载入', () => {
  it('渲染步骤标题与判据标签', async () => {
    mocks.getJson.mockResolvedValue(snapshot())
    const wrapper = mountView()
    await flushPromises()

    expect(wrapper.text()).toContain('客室侧门开关门功能试验')
    expect(wrapper.text()).toContain('检查门锁闭合')
    expect(wrapper.text()).toContain('门锁间隙')
    // 要求区间要写在标签里，现场才知道填多少算合格
    expect(wrapper.text()).toContain('要求 2–5 mm')
    wrapper.unmount()
  })

  it('会话已结束时跳转到记录页，而不是停在引导页', async () => {
    const data = snapshot()
    data.session.status = 'done'
    mocks.getJson.mockResolvedValue(data)
    const wrapper = mountView()
    await flushPromises()

    expect(mocks.replace).toHaveBeenCalled()
    wrapper.unmount()
  })
})

describe('RunView 提交：缺项与正常路径', () => {
  it('判据没填时不发请求，直接指出缺哪几项', async () => {
    mocks.getJson.mockResolvedValue(snapshot())
    const wrapper = mountView()
    await flushPromises()

    await clickButton(wrapper, '提交本步').trigger('click')
    await flushPromises()

    expect(mocks.postJson).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('请先填写：门锁间隙')
    wrapper.unmount()
  })

  it('填了合法值后提交，载荷是数字且通过时显示「本步通过」', async () => {
    mocks.getJson.mockResolvedValue(snapshot())
    mocks.postJson.mockResolvedValue(submitResponse('pass'))
    const wrapper = mountView()
    await flushPromises()

    await wrapper.find('#c-c1').setValue('3')
    await clickButton(wrapper, '提交本步').trigger('click')
    await flushPromises()

    const call = mocks.postJson.mock.calls[0]
    expect(String(call[0])).toContain('/sessions/s1/steps/1')
    expect(call[1].values).toEqual({ c1: 3 })
    // 幂等键必须带：现场网络抖动重试不该产生两条记录
    expect(call[2].headers['Idempotency-Key']).toBeTruthy()

    expect(wrapper.text()).toContain('本步通过')
    // 只有一步，所以按钮是「完成并查看记录」
    expect(wrapper.text()).toContain('完成并查看记录')
    wrapper.unmount()
  })

  it('异常时三条出路都在（复测 / 转排查 / 停止）', async () => {
    mocks.getJson.mockResolvedValue(snapshot())
    mocks.postJson.mockResolvedValue(submitResponse('fail'))
    const wrapper = mountView()
    await flushPromises()

    // 填合法值：verdict 由服务端判，不看前端输入。填 9 会让按钮变成「仍要提交」，
    // 那是另一条用例要验的东西。
    await wrapper.find('#c-c1').setValue('3')
    await clickButton(wrapper, '提交本步').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('本步异常，需处置')
    // 少任何一个按钮，现场就只能刷新或放弃
    expect(wrapper.findAll('button').some((b) => b.text().includes('复测本步'))).toBe(true)
    expect(wrapper.findAll('button').some((b) => b.text().includes('转故障排查'))).toBe(true)
    expect(wrapper.findAll('button').some((b) => b.text().includes('停止作业'))).toBe(true)
    wrapper.unmount()
  })
})

describe('RunView 超差提示：只改文案，不阻断', () => {
  it('输入超差时底栏提示项数、主按钮换成「仍要提交」，但仍可提交', async () => {
    mocks.getJson.mockResolvedValue(snapshot())
    const wrapper = mountView()
    await flushPromises()

    await wrapper.find('#c-c1').setValue('9')
    await flushPromises()

    expect(wrapper.text()).toContain('1 项超差')
    const btn = clickButton(wrapper, '仍要提交')
    expect(btn.text()).toContain('1 项超差')
    // 关键：按钮不能因为超差就禁用——前端的职责是让人看见，不是替人拦住
    expect(btn.attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })
})
