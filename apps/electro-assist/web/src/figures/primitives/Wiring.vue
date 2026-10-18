<script setup lang="ts">
/** wiring：接线/端子顺序示意。
 *
 *  线色是**物理颜色**（棕/蓝/黄绿…），不随主题变，所以这里用十六进制字面量而不是
 *  CSS 令牌——换暗色皮肤时线色不该跟着变。未知线色统一画灰，并在图下注明，
 *  避免"看起来像画对了"。
 */
import { computed } from 'vue'
import type { ParamValue } from '../../types'
import { MONO, splitList, str } from '../svg'

const props = defineProps<{ params: Record<string, ParamValue>; label?: string }>()

const WIRE_COLORS: Record<string, string> = {
  棕: '#7b4b2a',
  蓝: '#1d5fbf',
  黄绿: '#7ba428',
  红: '#c0262a',
  黑: '#12181c',
  黄: '#d9a400',
  白: '#ffffff',
  绿: '#157f3d',
  灰: '#6b7a83',
  橙: '#c25e00',
  紫: '#6b3fa0',
  粉: '#d46a8a',
  浅蓝: '#57a8d8',
}

const BOX_W = 56
const GAP = 16
const STEP = BOX_W + GAP
const LEFT = 20

const model = computed(() => {
  const terminals = splitList(props.params.terminals)
  if (!terminals.length) throw new Error('wiring：缺少 terminals')
  if (terminals.length > 8) throw new Error('wiring：端子数超过 8 个')

  const colors = str(props.params.wire_color)
    .split(/[/、,]/)
    .map((s) => s.trim())
    .filter(Boolean)

  const width = Math.max(260, LEFT * 2 + terminals.length * STEP - GAP)
  const items = terminals.map((t, i) => {
    const name = colors.length ? colors[Math.min(i, colors.length - 1)] : ''
    const hex = WIRE_COLORS[name] ?? '#6b7a83'
    return { text: t, name, hex, x: LEFT + i * STEP }
  })

  return {
    width,
    items,
    note: str(props.params.note),
    unknown: items.some((i) => i.name && !WIRE_COLORS[i.name]),
    lineY: 104,
  }
})
</script>

<template>
  <svg
    :viewBox="`0 0 ${model.width} 138`"
    role="img"
    :aria-label="label || `端子顺序 ${model.items.map((i) => i.text).join('、')}`"
    preserveAspectRatio="xMidYMid meet"
  >
    <g v-for="item in model.items" :key="item.text">
      <rect
        :x="item.x"
        y="28"
        :width="BOX_W"
        height="42"
        rx="6"
        stroke-width="2"
        class="fig-surface fig-stroke-ink2"
      />
      <text
        :x="item.x + BOX_W / 2"
        y="49"
        text-anchor="middle"
        dominant-baseline="central"
        font-size="15"
        :font-family="MONO"
        class="fig-ink"
      >
        {{ item.text }}
      </text>
    </g>

    <line
      v-if="model.items.length > 1"
      :x1="model.items[0].x + BOX_W / 2"
      :y1="model.lineY"
      :x2="model.items[model.items.length - 1].x + BOX_W / 2"
      :y2="model.lineY"
      stroke-width="2"
      class="fig-stroke-line"
    />
    <circle
      v-for="item in model.items"
      :key="`dot-${item.text}`"
      :cx="item.x + BOX_W / 2"
      :cy="model.lineY"
      r="7"
      :fill="item.hex"
      :stroke="item.hex === '#ffffff' ? '#dfe5e8' : 'none'"
      stroke-width="1.5"
    />

    <text
      v-if="model.note"
      x="20"
      y="130"
      font-size="11"
      class="fig-ink3"
    >
      {{ model.note }}
    </text>
  </svg>
</template>
