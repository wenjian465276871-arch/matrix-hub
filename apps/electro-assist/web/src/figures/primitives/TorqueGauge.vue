<script setup lang="ts">
/** torque_gauge：力矩目标值与公差带。
 *
 *  量程取「目标 ± 3×公差」——固定 0–30 N·m 那种画法会让 0.8 N·m 的目标挤成一条线。
 *  公差带用琥珀色块，目标值用刻度线 + 大字读数双重标识。 */
import { computed } from 'vue'
import type { ParamValue } from '../../types'
import { MONO, num, str } from '../svg'

const props = defineProps<{ params: Record<string, ParamValue>; label?: string }>()

const CX = 170
const CY = 150
const R = 96

const rad = (deg: number): number => (deg * Math.PI) / 180
const point = (deg: number, r: number): [number, number] => [
  CX + r * Math.cos(rad(deg)),
  CY - r * Math.sin(rad(deg)),
]

function arc(from: number, to: number, r: number): string {
  const [x1, y1] = point(from, r)
  const [x2, y2] = point(to, r)
  const large = Math.abs(to - from) > 180 ? 1 : 0
  return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`
}

const model = computed(() => {
  const target = num(props.params.target, 'target')
  const tolerance = num(props.params.tolerance, 'tolerance', 0)
  if (target <= 0) throw new Error('torque_gauge：target 必须为正数')
  if (tolerance < 0) throw new Error('torque_gauge：tolerance 不能为负')

  const lo = tolerance > 0 ? Math.max(0, target - tolerance * 3) : 0
  const hi = tolerance > 0 ? target + tolerance * 3 : Math.max(target * 1.6, 1)
  const angle = (v: number): number => 180 - ((v - lo) / (hi - lo)) * 180

  const aTarget = angle(target)
  const aLow = tolerance > 0 ? angle(target - tolerance) : aTarget
  const aHigh = tolerance > 0 ? angle(target + tolerance) : aTarget

  return {
    target,
    tolerance,
    unit: str(props.params.unit),
    lo,
    hi,
    track: arc(180, 0, R),
    band: tolerance > 0 ? arc(aLow, aHigh, R) : '',
    tick: { x1: point(aTarget, R - 16)[0], y1: point(aTarget, R - 16)[1], x2: point(aTarget, R + 10)[0], y2: point(aTarget, R + 10)[1] },
    loLabel: point(180, R + 18),
    hiLabel: point(0, R + 18),
  }
})
</script>

<template>
  <svg
    viewBox="0 0 340 190"
    role="img"
    :aria-label="label || `力矩目标 ${model.target}${model.unit}，公差 ±${model.tolerance}`"
    preserveAspectRatio="xMidYMid meet"
  >
    <path
      :d="model.track"
      fill="none"
      stroke-width="16"
      stroke-linecap="round"
      class="fig-stroke-track"
    />
    <path
      v-if="model.band"
      :d="model.band"
      fill="none"
      stroke-width="16"
      stroke-linecap="butt"
      class="fig-stroke-warn-soft"
    />
    <line
      :x1="model.tick.x1"
      :y1="model.tick.y1"
      :x2="model.tick.x2"
      :y2="model.tick.y2"
      stroke-width="3"
      class="fig-stroke-ink"
    />

    <text
      :x="model.loLabel[0]"
      :y="model.loLabel[1]"
      text-anchor="start"
      font-size="11"
      :font-family="MONO"
      class="fig-ink3"
    >
      {{ model.lo }}
    </text>
    <text
      :x="model.hiLabel[0]"
      :y="model.hiLabel[1]"
      text-anchor="end"
      font-size="11"
      :font-family="MONO"
      class="fig-ink3"
    >
      {{ model.hi }}
    </text>

    <text
      x="170"
      y="132"
      text-anchor="middle"
      font-size="24"
      :font-family="MONO"
      class="fig-ink"
    >
      {{ model.target }}<tspan dx="4" font-size="14" class="fig-ink3">{{ model.unit }}</tspan>
    </text>
    <text x="170" y="160" text-anchor="middle" font-size="12" class="fig-ink2">
      <template v-if="model.tolerance > 0">目标 ± {{ model.tolerance }} {{ model.unit }}</template>
      <template v-else>目标值</template>
    </text>
  </svg>
</template>
