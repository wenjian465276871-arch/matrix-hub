<script setup lang="ts">
/** operation_scene：按场景分发的联动作业台。
 *
 *  | 场景 | 组件 | 右侧画什么 |
 *  |---|---|---|
 *  | `pantograph_raise` | `PantoOps` | 车顶受电弓（按住旋钮升弓） |
 *  | `hvac_cooling` | `OpsBoard` | 客室空调机组（MON 设模式、起通风/制冷） |
 *  | `door_switch` | `OpsBoard` | 客室侧门（司机台六个门控按钮） |
 *
 *  为什么升弓那份不并进 `OpsBoard`：它有一条别的场景没有的交互——"按住旋钮
 *  直到升到位"，还有"点 MON 跳到确认页"的分流。把它塞进通用组件会让三套联锁
 *  互相纠缠，而它已经有 40 条用例钉着。共用的是**交互约定**（点件=点按钮、
 *  状态灯常驻、打印换静态帧），不是同一份代码。
 */
import { computed } from 'vue'

import type { ParamValue } from '../../types'
import OpsBoard from './OpsBoard.vue'
import PantoOps from './PantoOps.vue'

const props = defineProps<{
  params: Record<string, ParamValue>
  label?: string
}>()

const scene = computed(() => String(props.params.scene ?? 'pantograph_raise'))
</script>

<template>
  <PantoOps v-if="scene === 'pantograph_raise'" :params="params" :label="label" />
  <OpsBoard v-else :params="params" :label="label" />
</template>
