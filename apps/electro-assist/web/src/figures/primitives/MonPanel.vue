<script setup lang="ts">
/** mon_panel：MON 车辆信息显示屏（按场景分发）。
 *
 *  2026-11-14 之前这个文件就是升弓那块屏。空调制冷与开关门两项试验也要用同一块
 *  MON，于是把它拆成"分发壳 + 三块屏"：
 *
 *  | 场景 | 页签 | 做什么 |
 *  |---|---|---|
 *  | `pantograph_raise` | 电源电压 / 车辆信息 / 远程控制切除 | 逐项核对，缺一项不许升弓 |
 *  | `hvac_cooling` | 空调设定 / 机组状态 / 客室温度 | 选模式与设定温度、下发、看读数 |
 *  | `door_switch` | 车门状态 / 集控操作 / 故障与隔离 | 确认全列门状态、看集控与故障 |
 *
 *  为什么是分发而不是"一个组件塞三个 if"：三块屏的页签、行、联锁来源完全不同，
 *  塞在一起会变成 2000 行、每改一处都要先读懂另外两处。拆开之后各自的用例
 *  只测自己那块；这里只剩一行判断。
 *
 *  默认场景仍是 `pantograph_raise`：旧样例、旧测试与已发布的指导书都不带
 *  `scene` 参数时，行为必须与拆分前逐字一致。
 */
import { computed } from 'vue'

import type { ParamValue } from '../../types'
import DoorMon from './DoorMon.vue'
import HvacMon from './HvacMon.vue'
import PantoMon from './PantoMon.vue'

const props = defineProps<{
  params: Record<string, ParamValue>
  label?: string
  /** 见 `PantoMon` 的同名参数：只有"页面作业面"那一份才在屏外挂页面级动作。 */
  chrome?: boolean
}>()

const scene = computed(() => String(props.params.scene ?? 'pantograph_raise'))

/** 回执透传：作业台要把"已下发：通风"这类结果放到页面 HUD 上（紧凑版没有页脚）。 */
const emit = defineEmits<{ (e: 'receipt', text: string): void }>()
</script>

<template>
  <HvacMon
    v-if="scene === 'hvac_cooling'"
    :params="params"
    :label="label"
    @receipt="emit('receipt', $event)"
  />
  <DoorMon v-else-if="scene === 'door_switch'" :params="params" :label="label" />
  <PantoMon v-else-if="scene === 'pantograph_raise'" :params="params" :label="label" :chrome="chrome" />
  <!-- 未知场景不再兜到升弓屏（评审 R23-1）：那会把"配置写错"画成一块看着正常的屏。
       后端 `INTERACTIVE_SCENES` 会挡住新值，所以这条只在契约被绕过时出现。 -->
  <!-- 不加专属样式：这一块在 `ConfirmDialog-*.css` 这个聚合 chunk 里，
       而它刚好贴着 6400B 的预算（第七轮评审刚为紧凑版 MON 调过一次）。
       一个"契约被绕过"才会出现的兜底提示，不值得再顶一次预算。 -->
  <p v-else class="mon-unknown" role="alert">
    未知的 MON 场景「{{ scene }}」：应为 pantograph_raise / hvac_cooling / door_switch 之一。
  </p>
</template>
