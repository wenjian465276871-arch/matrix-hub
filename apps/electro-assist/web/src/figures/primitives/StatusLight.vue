<script setup lang="ts">
/** status_light：状态灯。三重编码——图形（✓ ! × –）+ 文字 + 颜色，
 *  不允许只靠颜色表意：现场有色觉差异，且黑白打印会全部糊成一个灰点。 */
import { computed } from 'vue'
import type { Scalar } from '../../types'
import { str } from '../svg'

const props = defineProps<{ params: Record<string, Scalar>; label?: string }>()

const STATES = {
  pass: { cls: 'fig-pass', glyph: '✓', text: '通过' },
  warn: { cls: 'fig-warn', glyph: '!', text: '注意' },
  danger: { cls: 'fig-danger', glyph: '×', text: '危险' },
  idle: { cls: 'fig-idle', glyph: '–', text: '未判定' },
} as const

const model = computed(() => {
  const raw = str(props.params.state)
  const state = STATES[raw as keyof typeof STATES]
  if (!state) throw new Error(`status_light：未知状态 ${raw}`)
  return { ...state, label: str(props.params.label) || state.text }
})
</script>

<template>
  <svg
    viewBox="0 0 340 88"
    role="img"
    :aria-label="`状态：${model.label}`"
    preserveAspectRatio="xMidYMid meet"
  >
    <circle cx="42" cy="44" r="27" fill="none" stroke-width="2" class="fig-stroke-line" />
    <circle cx="42" cy="44" r="20" :class="model.cls" />
    <text
      x="42"
      y="44"
      text-anchor="middle"
      dominant-baseline="central"
      font-size="20"
      font-weight="700"
      fill="#ffffff"
    >
      {{ model.glyph }}
    </text>
    <text x="84" y="44" dominant-baseline="central" font-size="15" class="fig-ink">
      {{ model.label }}
    </text>
    <text x="84" y="66" dominant-baseline="central" font-size="11" class="fig-ink3">
      {{ model.text }}
    </text>
  </svg>
</template>
