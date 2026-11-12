/** 图元注册表：primitive 名 → 渲染组件。
 *
 *  与后端 `models/visual.py` 的 `Primitive` 枚举一一对应。少一个或多一个，
 *  `GuideFigure` 都会走降级分支——这是有意的：宁可显示文字，也不显示错的图。
 *  新增原语必须同时改后端枚举、`_ALLOWED_PARAMS` 和这里，三处缺一不可。
 */
import type { Component } from 'vue'
import Annotation from './primitives/Annotation.vue'
import BakedFigure from './primitives/BakedFigure.vue'
import Callout from './primitives/Callout.vue'
import Checklist from './primitives/Checklist.vue'
import Connector from './primitives/Connector.vue'
import DeviceFigure from './primitives/DeviceFigure.vue'
import FlowArrow from './primitives/FlowArrow.vue'
import GateState from './primitives/GateState.vue'
import Meter from './primitives/Meter.vue'
import MonPanel from './primitives/MonPanel.vue'
import MotionTimeline from './primitives/MotionTimeline.vue'
import PantoOps from './primitives/PantoOps.vue'
import StatusLight from './primitives/StatusLight.vue'
import StepCard from './primitives/StepCard.vue'
import Table from './primitives/Table.vue'
import TorqueGauge from './primitives/TorqueGauge.vue'
import Wiring from './primitives/Wiring.vue'

export const FIGURES: Record<string, Component> = {
  step_card: StepCard,
  meter: Meter,
  status_light: StatusLight,
  wiring: Wiring,
  connector: Connector,
  torque_gauge: TorqueGauge,
  checklist: Checklist,
  motion_timeline: MotionTimeline,
  flow_arrow: FlowArrow,
  callout: Callout,
  gate_state: GateState,
  table: Table,
  annotation: Annotation,
  // 唯一一个内部再懒加载 Three.js 的原语：DeviceScene 里 `await import('three')`，
  // 不进指导书页面就不下载那 191KB。
  device_scene: DeviceFigure,
  baked_figure: BakedFigure,
  // 交互情景：带状态，不是一张图。见 `lib/panto-session.ts`。
  mon_panel: MonPanel,
  operation_scene: PantoOps,
}
