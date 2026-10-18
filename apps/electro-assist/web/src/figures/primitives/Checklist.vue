<script setup lang="ts">
/** checklist：检查清单（印刷用）。
 *
 *  items 是**分隔串**不是数组——契约里 params 只允许标量（见 models/visual.py）。
 *  分隔符约定 `|`（也兼容换行与分号），与服务端 `/schema/visual` 的说明一致。
 *  多行条目自动折行，宁可长高也不截断：截断的检查项等于没有。 */
import { computed } from 'vue'
import type { Scalar } from '../../types'
import { str, wrapText } from '../svg'

const props = defineProps<{ params: Record<string, Scalar>; label?: string }>()

const TEXT_W = 286
const LINE_H = 18

const model = computed(() => {
  const raw = str(props.params.items)
  const items = raw
    .split(/[|\n;；]/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (!items.length) throw new Error('checklist：items 为空')
  if (items.length > 10) throw new Error('checklist：条目超过 10 条')

  let y = 24
  const rows = items.map((text) => {
    const lines = wrapText(text, TEXT_W, 13, 2)
    const row = { text, lines, y }
    y += lines.length * LINE_H + 10
    return row
  })

  return { rows, height: y + 6 }
})
</script>

<template>
  <svg
    :viewBox="`0 0 340 ${model.height}`"
    role="img"
    :aria-label="label || `检查清单，共 ${model.rows.length} 项`"
    preserveAspectRatio="xMidYMid meet"
  >
    <g v-for="row in model.rows" :key="row.text">
      <rect
        x="12"
        :y="row.y - 12"
        width="16"
        height="16"
        rx="3"
        fill="none"
        stroke-width="1.5"
        class="fig-stroke-ink2"
      />
      <text
        v-for="(line, i) in row.lines"
        :key="i"
        x="38"
        :y="row.y + i * LINE_H"
        font-size="13"
        class="fig-ink"
      >
        {{ line }}
      </text>
    </g>
  </svg>
</template>
