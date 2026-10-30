<script setup lang="ts">
/** flow_arrow：操作流程箭头。
 *
 *  每行最多 3 个，宽度按"最多那一行"统一：不统一的话，末尾单个方块会被拉成
 *  整行宽，看起来像一个总结框，而不是流程的最后一步。
 *  换行处画一段折线箭头，明确"下一步从下一行左边继续"。
 */
import { computed } from 'vue'
import type { MotionTrack, ParamValue } from '../../types'
import { motionClasses } from '../motion'
import { splitList, wrapText } from '../svg'

const props = defineProps<{
  params: Record<string, ParamValue>
  label?: string
  motion?: MotionTrack[]
}>()

const PAD = 10
const GAP = 18
const PER_ROW = 3
const BOX_H = 40
const ROW_GAP = 22

interface Box {
  text: string
  lines: string[]
  x: number
  y: number
  w: number
  nextInRow: boolean
}

interface Link {
  fromX: number
  fromY: number
  toX: number
  toY: number
  midY: number
}

const model = computed(() => {
  const steps = splitList(props.params.steps)
  if (steps.length < 2) throw new Error('flow_arrow：steps 至少 2 步')
  if (steps.length > 5) throw new Error('flow_arrow：steps 超过 5 步')

  const columns = Math.min(PER_ROW, steps.length)
  const boxW = (340 - PAD * 2 - (columns - 1) * GAP) / columns
  const boxes: Box[] = []
  const links: Link[] = []

  for (let i = 0; i < steps.length; i += PER_ROW) {
    const chunk = steps.slice(i, i + PER_ROW)
    const y = 10 + (i / PER_ROW) * (BOX_H + ROW_GAP)
    chunk.forEach((text, j) => {
      boxes.push({
        text,
        lines: wrapText(text, boxW - 12, 11, 2),
        x: PAD + j * (boxW + GAP),
        y,
        w: boxW,
        nextInRow: j < chunk.length - 1,
      })
    })
    const nextIndex = i + PER_ROW
    if (nextIndex < steps.length) {
      const last = boxes[boxes.length - 1]
      const toX = PAD + boxW / 2
      const midY = y + BOX_H + ROW_GAP / 2
      links.push({
        fromX: last.x + last.w / 2,
        fromY: y + BOX_H,
        toX,
        toY: y + BOX_H + ROW_GAP,
        midY,
      })
    }
  }

  const rows = Math.ceil(steps.length / PER_ROW)
  return { boxes, links, height: 10 + rows * BOX_H + (rows - 1) * ROW_GAP + 10 }
})
</script>

<template>
  <svg
    :viewBox="`0 0 340 ${model.height}`"
    role="img"
    :aria-label="label || `操作流程，共 ${model.boxes.length} 步`"
    preserveAspectRatio="xMidYMid meet"
  >
    <g v-for="box in model.boxes" :key="box.text">
      <rect
        :x="box.x"
        :y="box.y"
        :width="box.w"
        :height="BOX_H"
        rx="6"
        stroke-width="1.2"
        class="fig-stroke-line fig-surface"
      />
      <text
        v-for="(line, i) in box.lines"
        :key="i"
        :x="box.x + box.w / 2"
        :y="box.y + 20 + (i - (box.lines.length - 1) / 2) * 14"
        text-anchor="middle"
        font-size="11"
        class="fig-ink"
      >
        {{ line }}
      </text>
      <template v-if="box.nextInRow">
        <line
          :x1="box.x + box.w + 3"
          :y1="box.y + BOX_H / 2"
          :x2="box.x + box.w + GAP - 6"
          :y2="box.y + BOX_H / 2"
          stroke-width="1.5"
          pathLength="100"
          :class="['fig-stroke-ink2', ...motionClasses(props.motion, 'arrow')]"
        />
        <polygon
          :points="`${box.x + box.w + GAP - 6},${box.y + BOX_H / 2} ${box.x + box.w + GAP - 11},${box.y + BOX_H / 2 - 3.5} ${box.x + box.w + GAP - 11},${box.y + BOX_H / 2 + 3.5}`"
          class="fig-ink2"
        />
      </template>
    </g>

    <!-- 换行连接：竖 → 横 → 竖，末段带箭头。少这一段，第二行会被读成并列而不是后续。 -->
    <g v-for="(link, index) in model.links" :key="`l-${index}`">
      <polyline
        :points="`${link.fromX},${link.fromY} ${link.fromX},${link.midY} ${link.toX},${link.midY} ${link.toX},${link.toY - 5}`"
        fill="none"
        stroke-width="1.5"
        pathLength="100"
        :class="['fig-stroke-ink2', ...motionClasses(props.motion, 'arrow')]"
      />
      <polygon
        :points="`${link.toX},${link.toY} ${link.toX - 3.5},${link.toY - 5} ${link.toX + 3.5},${link.toY - 5}`"
        class="fig-ink2"
      />
    </g>
  </svg>
</template>
