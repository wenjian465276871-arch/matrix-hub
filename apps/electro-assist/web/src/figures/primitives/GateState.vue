<script setup lang="ts">
/** gate_state：开关/闸门状态（正视示意）。
 *
 *  只表达"开了多少"，不表达结构：两扇门板的相对位置 + 中间开口。
 *  颜色是第二重编码（关闭=正常绿、半开=注意黄、开启=危险红），
 *  但文字永远在——现场有色觉差异的人不少，不能只靠颜色判断。
 */
import { computed } from 'vue'
import type { ParamValue } from '../../types'
import { str, wrapText } from '../svg'

const props = defineProps<{ params: Record<string, ParamValue>; label?: string }>()

const FRAME = { x: 70, y: 24, w: 200, h: 76 }
const STATE_LABEL: Record<string, string> = { open: '开启', half: '半开', closed: '关闭' }
const STATE_CLASS: Record<string, string> = {
  open: 'fig-danger',
  half: 'fig-warn',
  closed: 'fig-pass',
}

const model = computed(() => {
  const state = str(props.params.state)
  if (!(state in STATE_LABEL)) throw new Error('gate_state：state 只能是 open/closed/half')

  const leafW = state === 'closed' ? 97 : state === 'half' ? 50 : 16
  const left = { x: FRAME.x + 2, y: FRAME.y + 2, w: leafW, h: FRAME.h - 4 }
  const right = { x: FRAME.x + FRAME.w - 2 - leafW, y: FRAME.y + 2, w: leafW, h: FRAME.h - 4 }
  const note = wrapText(str(props.params.note), 316, 11, 2)
  const gapMid = (left.x + left.w + right.x) / 2
  return {
    state,
    label: STATE_LABEL[state],
    stateClass: STATE_CLASS[state],
    left,
    right,
    note,
    gapMid,
    hasGap: right.x - (left.x + left.w) > 6,
    height: 24 + FRAME.h + 12 + note.length * 15 + 6,
  }
})
</script>

<template>
  <svg
    :viewBox="`0 0 340 ${model.height}`"
    role="img"
    :aria-label="label || `门状态：${model.label}`"
    preserveAspectRatio="xMidYMid meet"
  >
    <text x="12" y="18" font-size="12" class="fig-ink2">
      {{ str(props.params.label) || '门状态' }}
    </text>
    <text x="328" y="18" text-anchor="end" font-size="12" :class="model.stateClass">
      {{ model.label }}
    </text>

    <rect
      :x="FRAME.x"
      :y="FRAME.y"
      :width="FRAME.w"
      :height="FRAME.h"
      rx="3"
      stroke-width="1.4"
      class="fig-stroke-line fig-surface"
    />
    <rect
      :x="model.left.x"
      :y="model.left.y"
      :width="model.left.w"
      :height="model.left.h"
      rx="3"
      stroke-width="1.2"
      class="fig-stroke-primary fig-primary-soft"
    />
    <rect
      :x="model.right.x"
      :y="model.right.y"
      :width="model.right.w"
      :height="model.right.h"
      rx="3"
      stroke-width="1.2"
      class="fig-stroke-primary fig-primary-soft"
    />
    <line
      v-if="model.hasGap"
      :x1="model.gapMid"
      :y1="FRAME.y + 30"
      :x2="model.gapMid"
      :y2="FRAME.y + FRAME.h - 12"
      stroke-width="1.2"
      stroke-dasharray="4 4"
      class="fig-stroke-warn-soft"
    />
    <text
      v-if="model.hasGap"
      :x="model.gapMid"
      :y="FRAME.y + 18"
      text-anchor="middle"
      font-size="11"
      class="fig-ink3"
    >
      开口
    </text>

    <text
      v-for="(line, i) in model.note"
      :key="i"
      x="12"
      :y="FRAME.y + FRAME.h + 22 + i * 15"
      font-size="11"
      class="fig-ink3"
    >
      {{ line }}
    </text>
  </svg>
</template>
