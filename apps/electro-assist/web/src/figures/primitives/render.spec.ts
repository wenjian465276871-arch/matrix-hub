import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
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
 * 13 个视觉原语的**渲染**断言（补 C6 缺口）。
 *
 * 与 `primitives.spec.ts` 的分工：那个测「坏参数必须被拒绝」，这个测「好参数
 * 真的画出东西」。两者缺一不可——只验拒绝的话，13 个组件全渲染成空白 SVG
 * 也照样全绿。
 *
 * 参数不是编的：**逐条取自 `data/samples/*.json` 的真实实例**（52 个 figure
 * 里每个原语取第一条）。这样断言的就是线上正在渲染的那份输入。
 *
 * 断言两层：
 * 1. 语义层——参数里的关键文本必须出现在产物里（模型改了参数名、组件丢字段都会红）；
 * 2. 结构层——`toMatchSnapshot()`，SVG 结构或坐标意外变化会红。
 *
 * 边界说清：这是**结构断言 + 快照**，不是像素级视觉回归。它能抓「图没了 /
 * 元素丢了 / 文字丢了」，抓不住「形状画歪了、标注压线了」——后者仍要靠 E2E
 * 几何断言与真机验收。
 */

interface Case {
  name: string
  comp: Parameters<typeof mount>[0]
  params: Record<string, ParamValue>
  /** 必须出现在渲染产物里的文本片段（取自参数本身） */
  expectText: string[]
}

const CASES: Case[] = [
  {
    name: 'step_card',
    comp: StepCard,
    params: { index: 1, action: '确认无电并设置警示', hint: '先挂牌再动手' },
    expectText: ['确认无电并设置警示', '先挂牌再动手'],
  },
  {
    name: 'meter',
    comp: Meter,
    params: { value: 2.0, unit: 'mm', min: 1.0, max: 3.0, label: '中部间隙' },
    expectText: ['中部间隙', 'mm', '2'],
  },
  {
    name: 'wiring',
    comp: Wiring,
    params: { terminals: '1-2-3', wire_color: '棕/蓝/黄绿', note: '仅示意端子顺序' },
    expectText: ['仅示意端子顺序'],
  },
  {
    name: 'status_light',
    comp: StatusLight,
    params: { state: 'pass', label: '间隙合格' },
    expectText: ['间隙合格'],
  },
  {
    name: 'checklist',
    comp: Checklist,
    params: {
      items: ['绝缘电阻已测且合格', '输入电压在范围内', '自检通过、无报警', '节点地址与版本已核对'],
    },
    expectText: ['绝缘电阻已测且合格', '节点地址与版本已核对'],
  },
  {
    name: 'flow_arrow',
    comp: FlowArrow,
    params: { steps: ['断开主控并挂牌', '验电确认无电', '设置防溜车', '确认门区无人'] },
    expectText: ['断开主控并挂牌', '确认门区无人'],
  },
  {
    name: 'annotation',
    comp: Annotation,
    params: {
      title: '门区作业部位',
      points: ['门扇：检查间隙', '门机：复紧螺栓', '门控器：核对插头'],
    },
    expectText: ['门区作业部位', '门扇：检查间隙'],
  },
  {
    name: 'connector',
    comp: Connector,
    params: {
      pins: [
        'X1-1 电源正',
        'X1-2 电源负',
        'X1-3 自检回馈',
        'X2-2 零速安全',
        'X2-3 信号公共',
        'X3-1 内钥匙',
        'X3-2 外钥匙',
      ],
      note: '针脚定义按公开资料改写，仅示意顺序',
    },
    /* 2026-11-12：connector 改成"位号在框里、功能在框下"两行（原来整串塞进
       30px 方框，七个针脚互相压字）。文本仍是这两段，快照已随之更新。 */
    expectText: ['X1-1 电源正', 'X3-2 外钥匙'],
  },
  {
    name: 'gate_state',
    comp: GateState,
    params: { state: 'half', label: '门扇位置', note: '隔离后应可手动半开，松手不自动回位' },
    expectText: ['门扇位置'],
  },
  {
    name: 'torque_gauge',
    comp: TorqueGauge,
    params: { target: 0.8, tolerance: 0.1, unit: 'N·m' },
    expectText: ['0.8', 'N·m'],
  },
  {
    name: 'callout',
    comp: Callout,
    params: { target: '门机安装螺栓', note: '对角顺序分两次复紧至规定力矩', position: 'right' },
    expectText: ['门机安装螺栓'],
  },
  {
    name: 'motion_timeline',
    comp: MotionTimeline,
    params: {
      steps: [
        '0–0.4s 收到开门指令',
        '0.4–1.2s 解锁并启动',
        '1.2–2.8s 匀速运行至全开',
        '2.8–3.2s 到位缓冲',
      ],
      total: '3.2s',
    },
    expectText: ['收到开门指令', '3.2s'],
  },
  {
    name: 'table',
    comp: Table,
    params: {
      headers: ['项目', '标准'],
      rows: ['门扇间隙|2.0–5.0mm', '锁闭信号|100% 关闭', '关门到位|无回弹'],
    },
    expectText: ['门扇间隙', '2.0–5.0mm', '关门到位'],
  },
]

describe('13 个视觉原语的渲染（真实参数 + 结构与快照）', () => {
  it('覆盖 13 个原语，且每个都有断言', () => {
    expect(CASES).toHaveLength(13)
    expect(new Set(CASES.map((c) => c.name)).size).toBe(13)
  })

  for (const item of CASES) {
    it(`${item.name}：渲染出 SVG 且关键文本在位`, () => {
      const wrapper = mount(item.comp, { props: { params: item.params } })

      // 原语必须产出 SVG 根节点：没有它，页面上就是一片空白
      const svg = wrapper.find('svg')
      expect(svg.exists(), `${item.name} 没渲染出 <svg>`).toBe(true)

      // 语义层：参数里的关键文本必须真的**画出来**。
      // 只查 `<text>` 节点，不查整段 html——`<title>` 与 `aria-label` 里也有
      // 这些字符串（给读屏用的），拿 html 做断言的话，文字没画出来也会通过。
      const visible = wrapper
        .findAll('text')
        .map((node) => node.text())
        .join(' ')
      for (const text of item.expectText) {
        expect(visible, `${item.name} 的可见文本里找不到「${text}」（当前：${visible.slice(0, 120)}）`).toContain(
          text,
        )
      }

      // 结构层：坐标或子结构意外变化时，这里会红
      expect(wrapper.html()).toMatchSnapshot()

      wrapper.unmount()
    })
  }
})
