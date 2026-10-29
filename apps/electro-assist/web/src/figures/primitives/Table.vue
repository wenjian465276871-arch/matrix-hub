<script setup lang="ts">
/** table：参数对照表。
 *
 *  列宽按"该列最长文本"分配，而不是均分：均分时「项目」一列空半行，
 *  「标准」一列被挤成三行。表格的价值在横向对齐，读错行就等于没有。
 *  行内用 `|` 分格，格数由服务端校验，前端只负责画。
 */
import { computed } from 'vue'
import type { ParamValue } from '../../types'
import { splitList, textWidth, wrapText } from '../svg'

const props = defineProps<{ params: Record<string, ParamValue>; label?: string }>()

const TOTAL_W = 340
const CELL_PAD = 6
const FONT = 11
const LINE_H = 15

const model = computed(() => {
  const headers = splitList(props.params.headers, /[|]/)
  const rawRows = splitList(props.params.rows, /[\n]/)
  if (headers.length < 2) throw new Error('table：headers 至少 2 列')
  if (!rawRows.length) throw new Error('table：rows 为空')

  const rows = rawRows.map((line) => {
    const cells = line.split('|').map((cell) => cell.trim())
    if (cells.length !== headers.length) {
      throw new Error(`table：行「${line.slice(0, 12)}」格数与表头不一致`)
    }
    return cells
  })

  const weights = headers.map((header, col) =>
    Math.max(
      textWidth(header, FONT),
      ...rows.map((cells) => textWidth(cells[col], FONT)),
      18,
    ),
  )
  const total = weights.reduce((sum, w) => sum + w, 0)
  const widths = weights.map((w) => (w / total) * TOTAL_W)

  let y = 0
  const layout = rows.map((cells) => {
    const wrapped = cells.map((cell, col) => wrapText(cell, widths[col] - CELL_PAD * 2, FONT, 3))
    const h = Math.max(...wrapped.map((lines) => lines.length)) * LINE_H + 10
    const row = { y, h, wrapped }
    y += h
    return row
  })

  // 列起点用累加而不是 reduce 带下标：reduce 的下标参数在这里是噪音，
  // 而且 noUnusedParameters 会直接把它判成错误。
  const xs: number[] = []
  let cursor = 0
  for (const width of widths) {
    xs.push(cursor)
    cursor += width
  }

  return {
    headers,
    widths,
    xs,
    rows: layout,
    headerH: 26,
    height: 26 + y + 2,
    vertical: rows.length,
  }
})
</script>

<template>
  <svg
    :viewBox="`0 0 340 ${model.height}`"
    role="img"
    :aria-label="label || `对照表，${model.vertical} 行`"
    preserveAspectRatio="xMidYMid meet"
  >
    <rect x="0" y="0" width="340" :height="model.headerH" class="fig-track" />
    <g v-for="(header, col) in model.headers" :key="header">
      <text
        :x="model.xs[col] + 6"
        y="17"
        font-size="11"
        class="fig-ink"
        font-weight="600"
      >
        {{ header }}
      </text>
      <line
        v-if="col > 0"
        :x1="model.xs[col]"
        y1="0"
        :x2="model.xs[col]"
        :y2="model.height"
        stroke-width="1"
        class="fig-stroke-line"
      />
    </g>

    <g v-for="(row, rowIndex) in model.rows" :key="rowIndex">
      <rect
        x="0"
        :y="model.headerH + row.y"
        width="340"
        :height="row.h"
        :class="rowIndex % 2 === 0 ? 'fig-surface' : 'fig-primary-soft'"
      />
      <line
        x1="0"
        :y1="model.headerH + row.y + row.h"
        x2="340"
        :y2="model.headerH + row.y + row.h"
        stroke-width="1"
        class="fig-stroke-line"
      />
      <text
        v-for="(lines, col) in row.wrapped"
        :key="col"
        font-size="11"
        class="fig-ink"
      >
        <tspan
          v-for="(line, i) in lines"
          :key="i"
          :x="model.xs[col] + 6"
          :y="model.headerH + row.y + 15 + i * 15"
        >{{ line }}</tspan>
      </text>
    </g>
    <rect
      x="0.5"
      y="0.5"
      width="339"
      :height="model.height - 1"
      fill="none"
      stroke-width="1"
      class="fig-stroke-line"
    />
  </svg>
</template>
