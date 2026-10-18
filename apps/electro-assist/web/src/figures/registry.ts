/** 图元注册表：primitive 名 → 渲染组件。
 *
 *  与后端 `models/visual.py` 的 `Primitive` 枚举一一对应。少一个或多一个，
 *  `GuideFigure` 都会走降级分支——这是有意的：宁可显示文字，也不显示错的图。
 *  新增原语必须同时改后端枚举、`_ALLOWED_PARAMS` 和这里，三处缺一不可。
 */
import type { Component } from 'vue'
import Checklist from './primitives/Checklist.vue'
import Connector from './primitives/Connector.vue'
import Meter from './primitives/Meter.vue'
import StatusLight from './primitives/StatusLight.vue'
import StepCard from './primitives/StepCard.vue'
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
}
