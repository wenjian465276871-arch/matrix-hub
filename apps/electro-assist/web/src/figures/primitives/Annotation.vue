<script setup lang="ts">
/** annotation：标注示意图（编号点 + 图例）。
 *
 *  刻意不画设备轮廓：模型没有几何信息，画得越像越容易被当成"这就是实车"。
 *  这里给的是"编号点 + 一句部位说明"，让人对着实物找位置，而不是照着图猜结构。
 */
import { computed } from 'vue'
import type { ParamValue } from '../../types'
import { splitList, str, wrapText } from '../svg'

const props = defineProps<{ params: Record<string, ParamValue>; label?: string }>()

const PANEL = { x: 12, y: 26, w: 316, h: 96 }

const model = computed(() => {
  const points = splitList(props.params.points)
  if (!points.length) throw new Error('annotation：points 为空')
  if (points.length > 6) throw new Error('annotation：points 超过 6 个')

  const step = PANEL.w / points.length
  const markers = points.map((text, index) => ({
    index: index + 1,
    text,
    cx: PANEL.x + step * (index + 0.5),
    cy: PANEL.y + PANEL.h / 2,
    legend: wrapText(`${index + 1}. ${text}`, 300, 11, 1)[0] ?? text,
    ly: PANEL.y + PANEL.h + 20 + index * 16,
  }))
  return {
    markers,
    title: str(props.params.title),
    height: PANEL.y + PANEL.h + 16 + points.length * 16 + 4,
  }
})
</script>

<template>
  <svg
    :viewBox="`0 0 340 ${model.height}`"
    role="img"
    :aria-label="label || `标注示意，共 ${model.markers.length} 处`"
    preserveAspectRatio="xMidYMid meet"
  >
    <text v-if="model.title" x="12" y="16" font-size="12" class="fig-ink2">
      {{ model.title }}
    </text>
    <rect
      :x="PANEL.x"
      :y="PANEL.y"
      :width="PANEL.w"
      :height="PANEL.h"
      rx="8"
      stroke-width="1.2"
      stroke-dasharray="6 4"
      class="fig-stroke-line fig-surface"
    />
    <line
      v-for="i in 3"
      :key="i"
      :x1="PANEL.x + 16"
      :y1="PANEL.y + 20 + (i - 1) * 24"
      :x2="PANEL.x + PANEL.w - 16"
      :y2="PANEL.y + 20 + (i - 1) * 24"
      stroke-width="1"
      class="fig-stroke-track"
    />
    <g v-for="marker in model.markers" :key="marker.index">
      <line
        :x1="marker.cx"
        :y1="marker.cy + 11"
        :x2="marker.cx"
        :y2="PANEL.y + PANEL.h - 8"
        stroke-width="1"
        class="fig-stroke-track"
      />
      <circle :cx="marker.cx" :cy="marker.cy" r="11" class="fig-primary" />
      <text
        :x="marker.cx"
        :y="marker.cy + 4"
        text-anchor="middle"
        font-size="11"
        class="fig-on-primary"
      >
        {{ marker.index }}
      </text>
      <text :x="12" :y="marker.ly" font-size="11" class="fig-ink">
        {{ marker.legend }}
      </text>
    </g>
  </svg>
</template>
