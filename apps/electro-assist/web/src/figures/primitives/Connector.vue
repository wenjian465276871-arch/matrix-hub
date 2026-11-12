<script setup lang="ts">
/** connector：接插件针脚定义。每行最多 6 针，最多 12 针——
 *  再多就不是"示意"而是图纸了，应该用真实照片。
 *
 *  2026-11-12 重排（本人：图中"字母与数字重叠"）：
 *  原来把整串 `X1-1 电源正` 塞进一个 30px 的方框、列距固定 44px，
 *  13px 等宽字下四个字符就已经溢框，七个针脚互相压字，糊成一片。
 *  现在按真实针脚表的读法拆成两行：**位号在框里、功能在框下**，
 *  列宽按这一列最长的文字算，行内均分，不再有固定步长的假设。 */
import { computed } from 'vue'
import type { ParamValue } from '../../types'
import { MONO, splitList, str } from '../svg'

const props = defineProps<{ params: Record<string, ParamValue>; label?: string }>()

const PER_ROW = 6
const CODE_FS = 13
const DESC_FS = 11
const BOX_H = 30
/** 一列的最小宽度：位号四个字符（X1-1）在 13px 等宽下约 31px。 */
const MIN_COL = 46

/** 等宽字下粗估文字宽度：汉字按 1 个字宽、ASCII 按 0.6 个字宽。
 *  不引 measurement API——SVG 在服务端/测试环境没有布局引擎，量不出来。 */
function textWidth(text: string, fs: number): number {
  let w = 0
  for (const ch of text) w += ch.charCodeAt(0) > 0x2e80 ? fs : fs * 0.6
  return w
}

const model = computed(() => {
  const pins = splitList(props.params.pins)
  if (!pins.length) throw new Error('connector：缺少 pins')
  if (pins.length > 12) throw new Error('connector：针脚数超过 12 个')

  /* 拆分位号与功能：`X1-1 电源正` → code=X1-1 / desc=电源正。
     没有空格就当作只有位号，desc 为空。 */
  const cells = pins.map((p) => {
    const at = p.search(/\s/)
    const code = at > 0 ? p.slice(0, at) : p
    const desc = at > 0 ? p.slice(at + 1).trim() : ''
    const boxW = Math.max(34, textWidth(code, CODE_FS) + 10)
    return { code, desc, boxW, need: Math.max(boxW, textWidth(desc, DESC_FS)) + 10 }
  })

  const cols = Math.min(cells.length, PER_ROW)
  const rows = Math.ceil(cells.length / PER_ROW)
  // 列宽取全表最大需求，行与行才对得齐
  const colW = Math.max(MIN_COL, ...cells.map((c) => c.need))
  const width = Math.max(260, 20 + cols * colW)
  const note = str(props.params.note)
  const bodyH = rows * 56 + 14
  const height = 14 + bodyH + (note ? 26 : 8)

  const items = cells.map((c, i) => ({
    ...c,
    x: 10 + (i % PER_ROW) * colW,
    y: 26 + Math.floor(i / PER_ROW) * 56,
  }))

  return { pins, items, width, height, bodyH, note, rows, colW }
})
</script>

<template>
  <svg
    :viewBox="`0 0 ${model.width} ${model.height}`"
    role="img"
    :aria-label="label || `接插件针脚 ${model.pins.join('、')}`"
    preserveAspectRatio="xMidYMid meet"
  >
    <title>{{ label || `接插件针脚 ${model.pins.join('、')}` }}</title>
    <rect
      x="8"
      y="14"
      :width="model.width - 16"
      :height="model.bodyH"
      rx="10"
      stroke-width="2"
      class="fig-surface fig-stroke-ink2"
    />
    <g v-for="item in model.items" :key="item.code">
      <!-- 位号：方框按这一列的位号宽度撑开，居中 -->
      <rect
        :x="item.x + (model.colW - item.boxW) / 2"
        :y="item.y"
        :width="item.boxW"
        :height="BOX_H"
        rx="4"
        stroke-width="1"
        class="fig-track fig-stroke-line"
      />
      <text
        :x="item.x + model.colW / 2"
        :y="item.y + BOX_H / 2"
        text-anchor="middle"
        dominant-baseline="central"
        :font-size="CODE_FS"
        :font-family="MONO"
        class="fig-ink"
      >
        {{ item.code }}
      </text>
      <!-- 功能：写在框下，不再挤进框里 -->
      <text
        v-if="item.desc"
        :x="item.x + model.colW / 2"
        :y="item.y + BOX_H + 13"
        text-anchor="middle"
        :font-size="DESC_FS"
        class="fig-ink3"
      >
        {{ item.desc }}
      </text>
    </g>
    <text
      v-if="model.note"
      x="8"
      :y="model.height - 8"
      font-size="11"
      class="fig-ink3"
    >
      {{ model.note }}
    </text>
  </svg>
</template>
