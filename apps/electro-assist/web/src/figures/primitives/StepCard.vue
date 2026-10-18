<script setup lang="ts">
/** step_card：步骤卡。
 *
 *  这是唯一"以文字为主"的原语，价值在于把一步动作从正文里拎出来、
 *  给一个足够大的序号——现场扫视时序号比标题更快定位。
 *  icon 参数只接受 ≤2 个字符的短标记，超长直接忽略（不为了装饰冒排版风险）。 */
import { computed } from 'vue'
import type { ParamValue } from '../../types'
import { MONO, num, str, wrapText } from '../svg'

const props = defineProps<{ params: Record<string, ParamValue>; label?: string }>()

const TEXT_W = 232
const LINE_H = 22

const model = computed(() => {
  const index = num(props.params.index, 'index', 1)
  const action = str(props.params.action)
  if (!action) throw new Error('step_card：缺少 action')

  const lines = wrapText(action, TEXT_W, 15, 3)
  const hint = str(props.params.hint)
  const iconRaw = str(props.params.icon)
  const icon = iconRaw.length > 0 && iconRaw.length <= 3 ? iconRaw : ''

  const top = 30
  const bodyTop = top + 8
  const bodyBottom = bodyTop + lines.length * LINE_H
  const height = (hint ? bodyBottom + 30 : bodyBottom + 14) + 6

  return { index, action, lines, hint, icon, bodyTop, bodyBottom, height, lineH: LINE_H }
})
</script>

<template>
  <svg
    :viewBox="`0 0 340 ${model.height}`"
    role="img"
    :aria-label="label || `第 ${model.index} 步：${model.action}`"
    preserveAspectRatio="xMidYMid meet"
  >
    <rect
      x="8"
      y="8"
      width="324"
      :height="model.height - 16"
      rx="10"
      stroke-width="1"
      class="fig-primary-soft fig-stroke-primary"
    />
    <circle cx="44" cy="44" r="20" class="fig-primary" />
    <text
      x="44"
      y="44"
      text-anchor="middle"
      dominant-baseline="central"
      font-size="17"
      font-weight="700"
      fill="#ffffff"
      :font-family="MONO"
    >
      {{ model.index }}
    </text>

    <text
      v-for="(line, i) in model.lines"
      :key="i"
      x="78"
      :y="model.bodyTop + 14 + i * model.lineH"
      font-size="15"
      class="fig-ink"
    >
      {{ line }}
    </text>

    <text v-if="model.icon" x="320" y="28" text-anchor="end" font-size="16" class="fig-ink3">
      {{ model.icon }}
    </text>

    <template v-if="model.hint">
      <rect x="78" :y="model.bodyBottom + 8" width="3" height="14" class="fig-primary" />
      <text x="90" :y="model.bodyBottom + 20" font-size="12" class="fig-ink3">
        {{ model.hint }}
      </text>
    </template>
  </svg>
</template>
