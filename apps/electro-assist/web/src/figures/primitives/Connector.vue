<script setup lang="ts">
/** connector：接插件针脚定义。超过 6 针自动换行，最多 12 针——
 *  再多就不是"示意"而是图纸了，应该用真实照片。 */
import { computed } from 'vue'
import type { Scalar } from '../../types'
import { MONO, splitList, str } from '../svg'

const props = defineProps<{ params: Record<string, Scalar>; label?: string }>()

const PER_ROW = 6
const PIN = 30
const STEP = 44

const model = computed(() => {
  const pins = splitList(props.params.pins)
  if (!pins.length) throw new Error('connector：缺少 pins')
  if (pins.length > 12) throw new Error('connector：针脚数超过 12 个')

  const cols = Math.min(pins.length, PER_ROW)
  const rows = Math.ceil(pins.length / PER_ROW)
  const width = Math.max(260, 44 + cols * STEP)
  const note = str(props.params.note)
  const bodyH = rows * 52 + 16
  const height = 14 + bodyH + (note ? 26 : 8)

  const items = pins.map((p, i) => ({
    text: p,
    x: 22 + (i % PER_ROW) * STEP,
    y: 28 + Math.floor(i / PER_ROW) * 52,
  }))

  return { pins, items, width, height, bodyH, note, rows }
})
</script>

<template>
  <svg
    :viewBox="`0 0 ${model.width} ${model.height}`"
    role="img"
    :aria-label="label || `接插件针脚 ${model.pins.join('、')}`"
    preserveAspectRatio="xMidYMid meet"
  >
    <rect
      x="8"
      y="14"
      :width="model.width - 16"
      :height="model.bodyH"
      rx="10"
      stroke-width="2"
      class="fig-surface fig-stroke-ink2"
    />
    <g v-for="item in model.items" :key="item.text">
      <rect
        :x="item.x"
        :y="item.y"
        :width="PIN"
        :height="PIN"
        rx="4"
        stroke-width="1"
        class="fig-track fig-stroke-line"
      />
      <text
        :x="item.x + PIN / 2"
        :y="item.y + PIN / 2"
        text-anchor="middle"
        dominant-baseline="central"
        font-size="13"
        :font-family="MONO"
        class="fig-ink"
      >
        {{ item.text }}
      </text>
    </g>
    <text
      v-if="model.note"
      x="8"
      :y="model.height - 8"
      font-size="11"
      class="fig-ink3"
    >
      {{ model.note }}
    </text>
  </svg>
</template>
