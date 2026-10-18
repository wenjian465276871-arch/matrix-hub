<script setup lang="ts">
/** meter：仪表读数。数值落在量程内用"通过"色，超差用"危险"色——
 *  颜色是第二重编码，旁边还有数值与量程文字，不靠颜色单独表意。 */
import { computed } from 'vue'
import type { Scalar } from '../../types'
import { MONO, num, str } from '../svg'

const props = defineProps<{ params: Record<string, Scalar>; label?: string }>()

const V = 340
const PAD = 16
const TRACK_W = V - PAD * 2
const TRACK_Y = 46
const TRACK_H = 14

const model = computed(() => {
  const min = num(props.params.min, 'min')
  const max = num(props.params.max, 'max')
  const value = num(props.params.value, 'value')
  if (max <= min) throw new Error('meter：max 必须大于 min')

  const ratio = Math.min(1, Math.max(0, (value - min) / (max - min)))
  const inRange = value >= min && value <= max
  return {
    min,
    max,
    value,
    ratio,
    inRange,
    unit: str(props.params.unit),
    label: str(props.params.label),
    x: PAD + TRACK_W * ratio,
  }
})
</script>

<template>
  <svg
    :viewBox="`0 0 ${V} 108`"
    role="img"
    :aria-label="label || `仪表读数 ${model.value}${model.unit}`"
    preserveAspectRatio="xMidYMid meet"
  >
    <text v-if="model.label" x="16" y="18" font-size="13" class="fig-ink2">
      {{ model.label }}
    </text>
    <text
      x="324"
      y="18"
      text-anchor="end"
      font-size="17"
      :font-family="MONO"
      class="fig-ink"
    >
      {{ model.value }}<tspan dx="4" font-size="12" class="fig-ink3">{{ model.unit }}</tspan>
    </text>

    <rect
      :x="PAD"
      :y="TRACK_Y"
      :width="TRACK_W"
      :height="TRACK_H"
      rx="7"
      class="fig-track"
    />
    <rect
      :x="PAD"
      :y="TRACK_Y"
      :width="Math.max(4, TRACK_W * model.ratio)"
      :height="TRACK_H"
      rx="7"
      :class="model.inRange ? 'fig-pass' : 'fig-danger'"
    />
    <line
      :x1="model.x"
      :y1="TRACK_Y - 8"
      :x2="model.x"
      :y2="TRACK_Y + TRACK_H + 8"
      stroke-width="2"
      class="fig-stroke-ink"
    />

    <text
      :x="PAD"
      :y="TRACK_Y + TRACK_H + 24"
      font-size="11"
      :font-family="MONO"
      class="fig-ink3"
    >
      {{ model.min }}
    </text>
    <text
      x="324"
      :y="TRACK_Y + TRACK_H + 24"
      text-anchor="end"
      font-size="11"
      :font-family="MONO"
      class="fig-ink3"
    >
      {{ model.max }}
    </text>
    <text
      x="170"
      :y="TRACK_Y + TRACK_H + 24"
      text-anchor="middle"
      font-size="11"
      :font-family="MONO"
      :class="model.inRange ? 'fig-pass' : 'fig-danger'"
    >
      {{ model.inRange ? '范围内' : '超差' }}
    </text>
  </svg>
</template>
