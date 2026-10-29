<script setup lang="ts">
/** callout：气泡标注（单点强调）。
 *
 *  只画"被标注物 + 一句话"，不画整台设备：模型没见过现场，画得越完整，
 *  错得越具体。target 是图上那一点的名称，note 是要提醒的那句话。
 */
import { computed } from 'vue'
import type { ParamValue } from '../../types'
import { str, wrapText } from '../svg'

const props = defineProps<{ params: Record<string, ParamValue>; label?: string }>()

const model = computed(() => {
  const target = str(props.params.target).trim()
  const note = str(props.params.note).trim()
  if (!target || !note) throw new Error('callout：target 与 note 都不能为空')

  const position = str(props.params.position) || 'right'
  const vertical = position === 'top' || position === 'bottom'
  const boxH = vertical ? 52 : 68
  const noteLines = wrapText(note, vertical ? 300 : 124, 11, 3)
  const targetLines = wrapText(target, vertical ? 300 : 124, 12, 2)

  if (vertical) {
    const bubbleY = position === 'top' ? 8 : 8 + boxH + 24
    const targetY = position === 'top' ? 8 + boxH + 24 : 8
    return {
      vertical,
      position,
      target: { x: 20, y: targetY, w: 300, h: boxH, lines: targetLines },
      bubble: { x: 20, y: bubbleY, w: 300, h: boxH, lines: noteLines },
      height: 8 + boxH * 2 + 24 + 8,
    }
  }

  const left = position === 'left'
  const targetX = left ? 188 : 12
  const bubbleX = left ? 12 : 188
  return {
    vertical,
    position,
    target: { x: targetX, y: 22, w: 140, h: 72, lines: targetLines },
    bubble: { x: bubbleX, y: 22, w: 140, h: 72, lines: noteLines },
    height: 116,
  }
})
</script>

<template>
  <svg
    :viewBox="`0 0 340 ${model.height}`"
    role="img"
    :aria-label="label || `标注：${str(params.target)}`"
    preserveAspectRatio="xMidYMid meet"
  >
    <rect
      :x="model.target.x"
      :y="model.target.y"
      :width="model.target.w"
      :height="model.target.h"
      rx="6"
      stroke-width="1.4"
      class="fig-stroke-ink2 fig-surface"
    />
    <text
      v-for="(line, i) in model.target.lines"
      :key="`t-${i}`"
      :x="model.target.x + model.target.w / 2"
      :y="model.target.y + model.target.h / 2 + 4 + (i - (model.target.lines.length - 1) / 2) * 16"
      text-anchor="middle"
      font-size="12"
      class="fig-ink"
    >
      {{ line }}
    </text>

    <rect
      :x="model.bubble.x"
      :y="model.bubble.y"
      :width="model.bubble.w"
      :height="model.bubble.h"
      rx="8"
      stroke-width="1.2"
      class="fig-stroke-primary fig-primary-soft"
    />
    <polygon
      v-if="!model.vertical && model.position === 'left'"
      :points="`${model.bubble.x + model.bubble.w},${model.bubble.y + 34} ${model.bubble.x + model.bubble.w + 10},${model.bubble.y + 40} ${model.bubble.x + model.bubble.w},${model.bubble.y + 46}`"
      class="fig-primary-soft"
    />
    <polygon
      v-else-if="!model.vertical"
      :points="`${model.bubble.x},${model.bubble.y + 34} ${model.bubble.x - 10},${model.bubble.y + 40} ${model.bubble.x},${model.bubble.y + 46}`"
      class="fig-primary-soft"
    />
    <polygon
      v-else-if="model.position === 'top'"
      :points="`${170 - 6},${model.bubble.y + model.bubble.h} 170,${model.bubble.y + model.bubble.h + 10} ${170 + 6},${model.bubble.y + model.bubble.h}`"
      class="fig-primary-soft"
    />
    <polygon
      v-else
      :points="`${170 - 6},${model.bubble.y} 170,${model.bubble.y - 10} ${170 + 6},${model.bubble.y}`"
      class="fig-primary-soft"
    />
    <text
      v-for="(line, i) in model.bubble.lines"
      :key="`n-${i}`"
      :x="model.bubble.x + model.bubble.w / 2"
      :y="model.bubble.y + model.bubble.h / 2 + 4 + (i - (model.bubble.lines.length - 1) / 2) * 15"
      text-anchor="middle"
      font-size="11"
      class="fig-ink"
    >
      {{ line }}
    </text>
  </svg>
</template>
