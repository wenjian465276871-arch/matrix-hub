<script setup lang="ts">
/** meter：仪表读数。
 *
 *  两种形态：
 *  - 有实测值：轨道 + 填充 + 指针 + 「范围内/超差」，颜色是第二重编码；
 *  - 只有允许范围（文档没给实测值时）：整条轨道即允许区间，不画指针。
 *    实测发现的真实情况：工艺文本常只写"允许 99-121V"，硬让模型编一个读数
 *    就是伪造数据；空着又会让整张图降级成文字。范围条是第三种正确答案。
 */
import { computed } from 'vue'
import type { MotionTrack, ParamValue } from '../../types'
import { motionClasses } from '../motion'
import { MONO, num, str } from '../svg'

const props = defineProps<{
  params: Record<string, ParamValue>
  label?: string
  motion?: MotionTrack[]
}>()

const V = 340
const PAD = 16
const TRACK_W = V - PAD * 2
const TRACK_Y = 46
const TRACK_H = 14

const model = computed(() => {
  const min = num(props.params.min, 'min')
  const max = num(props.params.max, 'max')
  if (max <= min) throw new Error('meter：max 必须大于 min')

  const raw = props.params.value
  const hasValue = raw !== undefined && raw !== null && String(raw).trim() !== ''
  const value = hasValue ? num(raw, 'value') : null

  const ratio = value === null ? 0 : Math.min(1, Math.max(0, (value - min) / (max - min)))
  const inRange = value === null ? true : value >= min && value <= max

  return {
    min,
    max,
    value,
    hasValue,
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
    :aria-label="
      label ||
      (model.hasValue
        ? `仪表读数 ${model.value}${model.unit}`
        : `允许范围 ${model.min} 至 ${model.max}${model.unit}`)
    "
    preserveAspectRatio="xMidYMid meet"
  >
    <text v-if="model.label" x="16" y="18" font-size="13" class="fig-ink2">
      {{ model.label }}
    </text>

    <text
      v-if="model.hasValue"
      x="324"
      y="18"
      text-anchor="end"
      font-size="17"
      :font-family="MONO"
      :class="['fig-ink', ...motionClasses(props.motion, 'readout')]"
    >
      {{ model.value }}<tspan dx="4" font-size="12" class="fig-ink3">{{ model.unit }}</tspan>
    </text>
    <text v-else x="324" y="18" text-anchor="end" font-size="12" class="fig-ink3">
      允许范围
    </text>

    <rect :x="PAD" :y="TRACK_Y" :width="TRACK_W" :height="TRACK_H" rx="7" class="fig-track" />
    <rect
      v-if="model.hasValue"
      :x="PAD"
      :y="TRACK_Y"
      :width="Math.max(4, TRACK_W * model.ratio)"
      :height="TRACK_H"
      rx="7"
      :class="model.inRange ? 'fig-pass' : 'fig-danger'"
    />
    <line
      v-if="model.hasValue"
      :x1="model.x"
      :y1="TRACK_Y - 8"
      :x2="model.x"
      :y2="TRACK_Y + TRACK_H + 8"
      stroke-width="2"
      pathLength="100"
      :class="['fig-stroke-ink', ...motionClasses(props.motion, 'needle')]"
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
      :class="model.hasValue ? (model.inRange ? 'fig-pass' : 'fig-danger') : 'fig-ink3'"
    >
      {{ model.hasValue ? (model.inRange ? '范围内' : '超差') : model.unit }}
    </text>
  </svg>
</template>
