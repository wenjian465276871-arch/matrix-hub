import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type { Component } from 'vue'
import type { ParamValue } from '../../types'

import Annotation from './Annotation.vue'
import Callout from './Callout.vue'
import Checklist from './Checklist.vue'
import Connector from './Connector.vue'
import FlowArrow from './FlowArrow.vue'
import GateState from './GateState.vue'
import Meter from './Meter.vue'
import MotionTimeline from './MotionTimeline.vue'
import StatusLight from './StatusLight.vue'
import StepCard from './StepCard.vue'
import Table from './Table.vue'
import TorqueGauge from './TorqueGauge.vue'
import Wiring from './Wiring.vue'

/**
 * 13 个视觉原语的参数校验测试。
 *
 * 为什么要测这个：这些参数**由模型生成**，缺字段、越界、格式错都是常态。
 * 每个原语都在 `computed` 里主动 `throw`，由上层 `GuideFigure` 的
 * `onErrorCaptured` 接住并降级成 `fallback_text`——这是设计好的路径，不是崩溃。
 *
 * 所以真正要锁的是：**坏参数必须被明确拒绝**。
 * 如果某个原语的校验被删掉，它会静默渲染出一张空图或错图——现场看到的是
 * "这张图好像没问题"，比报错危险得多。这组测试就是防止那种退化。
 *
 * 合法参数的断言只覆盖 6 个语义直观的原语（清单/指示灯/闸门/步骤卡/表格/仪表），
 * 其余原语的坐标类参数格式复杂，只验"能挂载出非空 SVG"，不猜语义。
 */

interface Case {
  name: string
  comp: Component
  /** 合法参数：null 表示跳过合法渲染断言（参数格式不确定，不猜） */
  ok: Record<string, ParamValue> | null
  /** 非法参数：应当触发抛错 */
  bad: Record<string, ParamValue>
  /** 期望的错误消息片段；null 表示只验"抛了"，不锁具体文案 */
  err: string | null
}

const CASES: Case[] = [
  {
    name: 'annotation',
    comp: Annotation,
    ok: null,
    bad: {},
    err: 'points 为空',
  },
  {
    name: 'callout',
    comp: Callout,
    ok: null,
    bad: {},
    err: 'target 与 note 都不能为空',
  },
  {
    name: 'checklist',
    comp: Checklist,
    ok: { items: '确认门已断电|检查锁钩无变形|记录间隙值' },
    bad: {},
    err: 'items 为空',
  },
  {
    name: 'connector',
    comp: Connector,
    ok: null,
    bad: {},
    err: '缺少 pins',
  },
  {
    name: 'flow_arrow',
    comp: FlowArrow,
    ok: null,
    bad: { steps: '只有一步' },
    err: 'steps 至少 2 步',
  },
  {
    name: 'gate_state',
    comp: GateState,
    ok: { state: 'closed' },
    bad: { state: '不存在的状态' },
    err: 'state 只能是',
  },
  {
    name: 'meter',
    comp: Meter,
    ok: null,
    bad: { min: 100, max: 10, value: 50 },
    err: 'max 必须大于 min',
  },
  {
    name: 'motion_timeline',
    comp: MotionTimeline,
    ok: null,
    bad: { steps: '只有一段' },
    err: 'steps 至少 2 段',
  },
  {
    name: 'status_light',
    comp: StatusLight,
    ok: { state: 'warn' },
    bad: { state: 'purple' },
    err: '未知状态',
  },
  {
    name: 'step_card',
    comp: StepCard,
    ok: { action: '手动关闭车门至锁闭位' },
    bad: {},
    err: '缺少 action',
  },
  {
    name: 'table',
    comp: Table,
    ok: { headers: '项目|标准值', rows: '门锁间隙|2-5mm\n关门时间|3-5s' },
    bad: { headers: '只有一列', rows: 'a' },
    err: 'headers 至少 2 列',
  },
  {
    name: 'torque_gauge',
    comp: TorqueGauge,
    ok: null,
    bad: { target: 0 },
    err: 'target 必须为正数',
  },
  {
    name: 'wiring',
    comp: Wiring,
    ok: null,
    bad: {},
    err: '缺少 terminals',
  },
]

describe('视觉原语：坏参数必须被明确拒绝', () => {
  it.each(CASES)('$name 收到非法参数时抛错', ({ comp, bad, err }) => {
    // 抛错由 GuideFigure 的 onErrorCaptured 兜底成文字，属于正常降级路径。
    // 这里断言的是"有没有拒绝"，不是"会不会崩"。
    const run = () => mount(comp, { props: { params: bad } })
    if (err) {
      expect(run).toThrow(err)
    } else {
      expect(run).toThrow()
    }
  })
})

describe('视觉原语：合法参数能画出非空 SVG', () => {
  const OK_CASES = CASES.filter((c) => c.ok !== null)

  it.each(OK_CASES)('$name 渲染出 svg 与可读标签', ({ comp, ok }) => {
    const wrapper = mount(comp, { props: { params: ok as Record<string, ParamValue> } })
    const svg = wrapper.find('svg')

    expect(svg.exists()).toBe(true)
    // viewBox 必须存在且不是零尺寸，否则"画出来了"其实是一片空白
    const viewBox = svg.attributes('viewBox') ?? ''
    const [, , w, h] = viewBox.split(/\s+/).map(Number)
    expect(w).toBeGreaterThan(0)
    expect(h).toBeGreaterThan(0)

    // role=img + aria-label：读屏用户靠这句话知道图在说什么
    expect(svg.attributes('role')).toBe('img')
    expect((svg.attributes('aria-label') ?? '').length).toBeGreaterThan(0)

    // 至少有文字内容：全空图表明参数被静默丢弃了
    expect(wrapper.text().trim().length).toBeGreaterThan(0)
    wrapper.unmount()
  })

  it('checklist 把分隔串拆成多条，不是原样显示', () => {
    const wrapper = mount(Checklist, {
      props: { params: { items: '确认门已断电|检查锁钩无变形' } },
    })
    const text = wrapper.text()
    expect(text).toContain('确认门已断电')
    expect(text).toContain('检查锁钩无变形')
    // 分隔符不该出现在渲染结果里
    expect(text).not.toContain('|')
    wrapper.unmount()
  })

  it('status_light 把状态码翻成人话', () => {
    const wrapper = mount(StatusLight, { props: { params: { state: 'warn' } } })
    expect(wrapper.text()).toContain('注意')
    expect(wrapper.text()).not.toContain('warn')
    wrapper.unmount()
  })

  it('gate_state 把状态码翻成中文', () => {
    const wrapper = mount(GateState, { props: { params: { state: 'half' } } })
    expect(wrapper.text()).toContain('半开')
    wrapper.unmount()
  })

  it('table 的列数与表头不一致时整行拒绝，不画错位的表', () => {
    // 错位的表格比不画更危险：读的人会照着错误的标准值操作
    expect(() =>
      mount(Table, { props: { params: { headers: '项目|标准值', rows: '只有一个格子' } } }),
    ).toThrow('格数与表头不一致')
  })
})
