<script setup lang="ts">
/** 全站播报容器（计划 §12.5 的 aria-live 双区）。
 *
 *  两个容器常驻 DOM、永不移除：`aria-live` 区域如果是后插入的，
 *  部分读屏不会播报它第一次的内容——容器必须在页面加载时就存在。
 *
 *  内容用 `sr-only` 隐藏而不是 `display:none`：后者会让整个节点
 *  从可访问性树里消失，读屏就读不到了。
 *
 *  先清空再写入（`text = ''` → nextTick → 写值）是为了让"同一句话再说一遍"
 *  也能被播报——读屏比较的是节点文本变化，文本没变就不播。
 */
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { onAnnounce } from '../../lib/announce'

const polite = ref('')
const assertive = ref('')

let off: (() => void) | null = null
const timers: number[] = []

function speak(target: typeof polite, text: string): void {
  target.value = ''
  // 一帧之后再写：清空与写入在同一帧里，DOM 只看到"最终值"，
  // 对读屏来说等于没变化。
  void nextTick(() => {
    target.value = text
    // 3 秒后淡出内容：留着会让后续相同文本无法再次触发变化。
    timers.push(
      window.setTimeout(() => {
        if (target.value === text) target.value = ''
      }, 3000),
    )
  })
}

onMounted(() => {
  off = onAnnounce((politeness, text) => {
    speak(politeness === 'assertive' ? assertive : polite, text)
  })
})

onBeforeUnmount(() => {
  off?.()
  timers.forEach((id) => window.clearTimeout(id))
})
</script>

<template>
  <div class="sr-only" role="status" aria-live="polite" aria-atomic="true">
    {{ polite }}
  </div>
  <div class="sr-only" role="alert" aria-live="assertive" aria-atomic="true">
    {{ assertive }}
  </div>
</template>
