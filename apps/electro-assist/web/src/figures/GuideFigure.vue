<script setup lang="ts">
/** GuideFigure：图示容器。
 *
 *  三条降级路径，任一触发都显示 `fallback_text`，绝不静默失败：
 *  1. primitive 不在注册表里（后端加了新原语、前端还没跟上）；
 *  2. 组件渲染抛错（参数不合法、数值越界、除零）；
 *  3. 组件内部主动抛错（例如 status_light 收到未知状态）。
 *
 *  为什么用 onErrorCaptured 而不是 if/else 预校验：校验逻辑只能覆盖已知错误，
 *  渲染期才暴露的问题（NaN 参与坐标计算、数组越界）必须靠兜底接住。
 */
import { computed, nextTick, onBeforeUnmount, onErrorCaptured, ref, watch } from 'vue'
import type { VisualSpec } from '../types'
import { FIGURES } from './registry'

const props = defineProps<{ spec: VisualSpec }>()

const failed = ref(false)
const reason = ref('')
const component = computed(() => FIGURES[props.spec.primitive] ?? null)

watch(
  () => props.spec,
  () => {
    failed.value = false
    reason.value = ''
  },
)

/* 点击放大（计划 §12.5 横屏 SE 档）。
   390 高的横屏里图示被压到约 93px，看不清指针与刻度；给一个全屏层看原尺寸。
   焦点纪律与抽屉一致：开层→焦点进关闭键、Tab 不出层、Esc 关、关完还回触发键。 */
const zoomed = ref(false)
/** 三维走"放大同一实例"（fixed），二维走弹层（重新渲染 SVG 很便宜）。
 *  为什么不能统一用弹层：弹层里是**新挂载的第二个组件**，对三维等于重建
 *  整个 WebGL 场景——1–2 秒空白，还多占一个上下文（浏览器有上限）。 */
const isScene = computed(() => props.spec.primitive === 'device_scene')
const zoomTrigger = ref<HTMLButtonElement | null>(null)
const zoomClose = ref<HTMLButtonElement | null>(null)

async function openZoom(): Promise<void> {
  zoomed.value = true
  document.documentElement.classList.add('is-figure-zoom')
  await nextTick()
  zoomClose.value?.focus()
}

async function closeZoom(): Promise<void> {
  if (!zoomed.value) return
  zoomed.value = false
  document.documentElement.classList.remove('is-figure-zoom')
  // 触发按钮上有 `v-if="!zoomed"`：关闭的这一刻它才被重新挂载，
  // 同步 focus 拿到的是旧引用（已卸载的节点），焦点会掉到 body。
  await nextTick()
  zoomTrigger.value?.focus()
}

function onZoomKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    closeZoom()
    return
  }
  // 层里只有「关闭」一个可聚焦元素，Tab 必须原地循环
  if (event.key === 'Tab') {
    event.preventDefault()
    zoomClose.value?.focus()
  }
}

onBeforeUnmount(() => {
  document.documentElement.classList.remove('is-figure-zoom')
})

onErrorCaptured((err) => {
  failed.value = true
  reason.value = err instanceof Error ? err.message : '图示渲染异常'
  // 返回 false 阻断冒泡：一张图渲不出来，不该炸掉整份指导书
  return false
})
</script>

<template>
  <!-- 放大态必须自己带 dialog 语义：二维走真弹层，三维是同一个 figure 改成
       position:fixed，没有 role 的话读屏完全不知道"页面进入了另一种状态"。 -->
  <figure
    class="figure"
    :class="{ 'figure--zoomed': zoomed && isScene }"
    :role="zoomed && isScene ? 'dialog' : undefined"
    :aria-modal="zoomed && isScene ? 'true' : undefined"
    :aria-label="zoomed && isScene ? `${spec.caption || '图示'}放大` : undefined"
    @keydown="zoomed && isScene ? onZoomKeydown($event) : undefined"
  >
    <figcaption v-if="spec.caption" class="figure__caption">{{ spec.caption }}</figcaption>
    <!-- 2026-11-07：8 步 / 20 图的正式案例 TBT 531ms、Perf 87（目标 ≥90）。
         只让「画布」参与 content-visibility，题注留在外面——实测整块跳过会把
         题注一起从无障碍树里拿掉（CDP 全量 AX 树里搜不到「收工确认」），
         而正文/判据始终可读。打印在 print.css 里还原为 visible。 -->
    <div class="figure__canvas">
      <component
        :is="component"
        v-if="component && !failed"
        :params="spec.params"
        :label="spec.caption || spec.fallback_text"
        :motion="spec.motion"
        :fallback="spec.fallback_text"
      />
      <p v-else class="figure__fallback">{{ spec.fallback_text }}</p>
    </div>
    <p v-if="failed" class="figure__pending">{{ reason }} · 已降级为文字</p>

    <button
      v-if="zoomed && isScene"
      ref="zoomClose"
      class="figure__zoom-close figure__zoom-close--scene"
      type="button"
      @click="closeZoom"
    >
      关闭放大
    </button>

    <!-- 三维图**任何尺寸下都给**这个入口：它是这一页的核心，
         矮窗口里塞进版面必然看不清读数（510px 高的窗口画布只有 140px）。
         二维图只在横屏短高出现——竖屏的 SVG 已经够大，多一个按钮是噪音。 -->
    <button
      v-if="!zoomed"
      ref="zoomTrigger"
      class="figure__zoom"
      :class="{ 'figure__zoom--scene': isScene }"
      type="button"
      @click="openZoom"
    >
      {{ isScene ? '放大看' : '点击放大' }}
    </button>
  </figure>

  <div
    v-if="zoomed && !isScene"
    class="figure__zoom-layer no-print"
    role="dialog"
    aria-modal="true"
    :aria-label="`${spec.caption || '图示'}放大`"
    @keydown="onZoomKeydown"
  >
    <figure class="figure__zoom-panel">
      <figcaption v-if="spec.caption" class="figure__zoom-caption">{{ spec.caption }}</figcaption>
      <component
        :is="component"
        v-if="component && !failed"
        :params="spec.params"
        :label="spec.caption || spec.fallback_text"
        :motion="spec.motion"
        :fallback="spec.fallback_text"
      />
    </figure>
    <button ref="zoomClose" class="figure__zoom-close" type="button" @click="closeZoom">
      关闭
    </button>
  </div>
</template>

<style scoped>
.figure {
  position: relative;
}

/* 首屏外的画布跳过布局与绘制：20 张内联 SVG 的同步布局就是 TBT 主因。
   `auto` 关键字记住上次渲染高度，滚动条不跳。题注不在这个容器里，
   所以读屏仍能读到「读数示例」这类文字。 */
.figure__canvas {
  content-visibility: auto;
  contain-intrinsic-size: auto 240px;
}

/* 默认不显示：竖屏图够大，只在横屏短高才需要 */
.figure__zoom {
  display: none;
  position: absolute;
  top: 6px;
  right: 6px;
  align-items: center;
  justify-content: center;
  min-width: 44px;
  min-height: 44px;
  padding: 0 10px;
  border: 1px solid var(--c-line);
  border-radius: 6px;
  background: var(--c-surface);
  color: var(--c-ink-2);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.figure__zoom:focus-visible {
  outline: 2px solid var(--c-primary);
  outline-offset: 2px;
}

@media (orientation: landscape) and (max-height: 560px) {
  .figure__zoom {
    display: inline-flex;
  }
}

/* 三维始终显示入口：它是这一步的核心，不是配图 */
.figure__zoom--scene {
  display: inline-flex;
}

/* ---------- 三维放大：放大同一个实例（fixed），不重新挂载 ---------- */

.figure--zoomed {
  position: fixed;
  inset: 0;
  z-index: 60;
  margin: 0;
  /* 双保险：父级若还有 max-height（StepPage 的 58vh），这里必须顶回去，
     否则"全屏"只剩一条横带。 */
  width: 100vw;
  height: 100vh;
  height: 100dvh;
  max-height: none;
  min-height: 0;
  padding: 14px 16px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: var(--c-bg);
  /* 一条缝都不能留：留了就是"放大后还能看到下面那半截页面" */
  overflow: hidden;
}

.figure--zoomed .figure__caption {
  flex: 0 0 auto;
}

.figure--zoomed .figure__canvas {
  flex: 1 1 auto;
  min-height: 0;
  content-visibility: visible;
}

/* flex 链要一路通到底：canvas → device → scene。
   断在任何一级，`.scene` 就拿不到确定高度，三维退回 3:2 自然高度，
   "放大"只放大一块白边（2026-11-10 在步骤页踩过同一个坑）。 */
.figure--zoomed .figure__canvas :deep(.device) {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.figure--zoomed .figure__canvas :deep(.device > .scene) {
  flex: 1 1 auto;
  height: auto;
  aspect-ratio: auto;
  min-height: 0;
}

.figure--zoomed .figure__canvas :deep(.device__controls),
.figure--zoomed .figure__canvas :deep(.device__note) {
  flex: 0 0 auto;
}

.figure__zoom-close--scene {
  flex: 0 0 auto;
  align-self: center;
}

.figure__zoom-layer {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 16px;
  background: rgba(12, 14, 18, 0.82);
}

.figure__zoom-panel {
  margin: 0;
  padding: 12px;
  /* 必须给宽度：只写 max-width 时面板宽度由内容撑，SVG 也就只有 340 单位宽，
     "放大"等于没放大。 */
  width: min(92vw, 680px);
  max-height: 78vh;
  overflow: auto;
  background: var(--c-surface);
  border-radius: 8px;
}

/* svg 在子组件里，scoped 选择器够不着。
   max-height 必须给：竖长图（清单 340×360）按宽铺满会长到 700px，
   390 高的横屏里直接被面板切掉半截——"放大"变成"看得更少"。
   留白就留白，图完整比铺满重要。 */
.figure__zoom-panel :deep(svg) {
  width: 100%;
  height: auto;
  max-width: none;
  max-height: calc(78vh - 88px);
}

.figure__zoom-caption {
  margin-bottom: 8px;
  color: var(--c-ink-2);
  font-size: 13px;
}

.figure__zoom-close {
  min-height: 48px;
  padding: 0 24px;
  border: none;
  border-radius: 6px;
  background: var(--c-surface);
  color: var(--c-ink);
  font: inherit;
  cursor: pointer;
}

/* 开层时锁滚动：全屏图下面还能滚，手指一滑整页跟着动 */
:global(html.is-figure-zoom) {
  overflow: hidden;
}
</style>
