<script setup lang="ts">
/** motion_timeline：运动时序。
 *
 *  竖排而不是横排：横排 6 段时每段只有 40px，"1.2–2.8s 门扇运行" 会被压成两个字。
 *  现场读的是"第几秒发生什么"，不是"总时长多长"，所以时间前缀留在文本里，
 *  不做坐标换算——换算过一次，图上就会出现文档没写的秒数。
 */
import { computed } from 'vue'
import type { ParamValue } from '../../types'
import { MONO, splitList, str, wrapText } from '../svg'

const props = defineProps<{ params: Record<string, ParamValue>; label?: string }>()

const ROW_H = 36
const TEXT_X = 40
const TEXT_W = 286

const model = computed(() => {
  const steps = splitList(props.params.steps)
  if (steps.length < 2) throw new Error('motion_timeline：steps 至少 2 段')
  if (steps.length > 6) throw new Error('motion_timeline：steps 超过 6 段')

  const rows = steps.map((text, index) => ({
    text,
    lines: wrapText(text, TEXT_W, 12, 2),
    y: 26 + index * ROW_H,
    index: index + 1,
  }))
  return {
    rows,
    total: str(props.params.total),
    height: 26 + (steps.length - 1) * ROW_H + 26,
  }
})
</script>

<template>
  <svg
    :viewBox="`0 0 340 ${model.height}`"
    role="img"
    :aria-label="label || `运动时序，共 ${model.rows.length} 段`"
    preserveAspectRatio="xMidYMid meet"
  >
    <line
      x1="20"
      :y1="model.rows[0].y - 10"
      x2="20"
      :y2="model.rows[model.rows.length - 1].y + 8"
      stroke-width="2"
      class="fig-stroke-track"
    />
    <g v-for="row in model.rows" :key="row.index">
      <circle cx="20" :cy="row.y - 4" r="7" class="fig-primary-soft" />
      <text
        x="20"
        :y="row.y - 0.5"
        text-anchor="middle"
        font-size="9"
        :font-family="MONO"
        class="fig-primary"
      >
        {{ row.index }}
      </text>
      <text
        v-for="(line, i) in row.lines"
        :key="i"
        :x="TEXT_X"
        :y="row.y + i * 16"
        font-size="12"
        class="fig-ink"
      >
        {{ line }}
      </text>
    </g>
    <text v-if="model.total" x="324" y="14" text-anchor="end" font-size="11" :font-family="MONO" class="fig-ink3">
      合计 {{ model.total }}
    </text>
  </svg>
</template>
