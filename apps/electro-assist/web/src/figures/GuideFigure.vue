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
/** 烘焙图（照片级渲染）与三维同等对待：都是"看不清就废了"的主图。
 *  2026-11-11 本人明确要求：实物图也要能像三维那样"放大看"。
 *  它走弹层（就是一张 <img>，重挂载零成本）。 */
const isBaked = computed(() => props.spec.primitive === 'baked_figure')
/** 交互情景（MON 屏、升弓操作台）不提供放大层：
 *  放大层是**重新挂载一个实例**，对这两类等于重建一套 WebGL + 丢掉当前页的滚动位置；
 *  而它们本来就是整栏高度、自己带操作条，放大没有增益。 */
const isOps = computed(
  () => props.spec.primitive === 'mon_panel' || props.spec.primitive === 'operation_scene',
)
const zoomTrigger = ref<HTMLButtonElement | null>(null)
const zoomClose = ref<HTMLButtonElement | null>(null)

/* ---------------- 放大层里的滚轮缩放 / 拖动 ----------------
 *  2026-11-12 本人：提示写着"滚轮可继续缩放浏览器"，实测滚轮毫无反应，
 *  而且这个界面要的是**只缩图、不缩整页**。
 *  所以：滚轮在层内被拦截（preventDefault），只改图片容器的 transform；
 *  页面既不会滚动也不会被浏览器缩放。放大后可以按住拖动平移。 */
const zoomScale = ref(1)
const zoomTx = ref(0)
const zoomTy = ref(0)
const zoomBody = ref<HTMLElement | null>(null)

const stageStyle = computed(() => ({
  transform: `translate(${zoomTx.value}px, ${zoomTy.value}px) scale(${zoomScale.value})`,
  transformOrigin: '0 0',
}))

/** 把位移夹回"图仍盖住可视区"的范围，免得一拖就拖出白边找回不来。 */
function clampPan(): void {
  const body = zoomBody.value
  if (!body) return
  const maxX = Math.max(0, (zoomScale.value - 1) * body.clientWidth)
  const maxY = Math.max(0, (zoomScale.value - 1) * body.clientHeight)
  zoomTx.value = Math.min(0, Math.max(-maxX, zoomTx.value))
  zoomTy.value = Math.min(0, Math.max(-maxY, zoomTy.value))
}

function resetZoom(): void {
  zoomScale.value = 1
  zoomTx.value = 0
  zoomTy.value = 0
}

function onZoomWheel(event: WheelEvent): void {
  if (!isBaked.value) return
  const body = zoomBody.value
  if (!body) return
  event.preventDefault()
  const rect = body.getBoundingClientRect()
  const px = event.clientX - rect.left
  const py = event.clientY - rect.top
  // 指数缩放：滚一格固定倍率，手感与地图一致
  const next = Math.min(4, Math.max(1, zoomScale.value * Math.exp(-event.deltaY * 0.0015)))
  if (next === zoomScale.value) return
  // 以光标为锚点：先把光标换算到图片坐标，缩放后再反算位移
  const sx = (px - zoomTx.value) / zoomScale.value
  const sy = (py - zoomTy.value) / zoomScale.value
  zoomScale.value = next
  zoomTx.value = px - sx * next
  zoomTy.value = py - sy * next
  clampPan()
}

let panFrom: { x: number; y: number; tx: number; ty: number } | null = null

function onPanStart(event: PointerEvent): void {
  if (!isBaked.value || zoomScale.value <= 1) return
  panFrom = { x: event.clientX, y: event.clientY, tx: zoomTx.value, ty: zoomTy.value }
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}

function onPanMove(event: PointerEvent): void {
  if (!panFrom) return
  zoomTx.value = panFrom.tx + (event.clientX - panFrom.x)
  zoomTy.value = panFrom.ty + (event.clientY - panFrom.y)
  clampPan()
}

function onPanEnd(): void {
  panFrom = null
}

async function openZoom(): Promise<void> {
  zoomed.value = true
  resetZoom()
  document.documentElement.classList.add('is-figure-zoom')
  await nextTick()
  zoomClose.value?.focus()
}

async function closeZoom(): Promise<void> {
  if (!zoomed.value) return
  zoomed.value = false
  resetZoom()
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

    <!-- 三维图与烘焙实物图**任何尺寸下都给**这个入口：它们是这一页的核心，
         矮窗口里塞进版面必然看不清读数（510px 高的窗口画布只有 140px）。
         纯 2D 图元只在横屏短高出现——竖屏的 SVG 已经够大，多一个按钮是噪音。 -->
    <button
      v-if="!zoomed && (isScene || isBaked) && !isOps"
      ref="zoomTrigger"
      class="figure__zoom"
      :class="isScene ? 'figure__zoom--scene' : 'figure__zoom--baked'"
      type="button"
      @click="openZoom"
    >
      放大看
    </button>
    <button
      v-else-if="!zoomed && !isOps"
      ref="zoomTrigger"
      class="figure__zoom"
      type="button"
      @click="openZoom"
    >
      点击放大
    </button>
  </figure>

  <div
    v-if="zoomed && !isScene"
    class="figure__zoom-layer no-print"
    :class="{ 'figure__zoom-layer--baked': isBaked }"
    role="dialog"
    aria-modal="true"
    :aria-label="`${spec.caption || '图示'}放大`"
    @keydown="onZoomKeydown"
  >
    <!-- 实物图：整页显示，图按可用空间等比放到最大。
         不做深色遮罩——纸面底色和页面一致，看起来像"把这张图翻到全屏"，
         而不是"弹了一个灯箱"；深底还会让透明背景的渲染图边缘发灰。 -->
    <template v-if="isBaked">
      <div class="zoom-frame">
        <div class="zoom-frame__bar">
          <span class="zoom-frame__label">{{ spec.caption || '步骤图示' }}</span>
          <span class="zoom-frame__hint">Esc 关闭 · 滚轮缩放图片 · 放大后可拖动</span>
        </div>
        <div
          ref="zoomBody"
          class="zoom-frame__body"
          :class="{ 'zoom-frame__body--pannable': zoomScale > 1 }"
          @wheel="onZoomWheel"
          @pointerdown="onPanStart"
          @pointermove="onPanMove"
          @pointerup="onPanEnd"
          @pointercancel="onPanEnd"
          @dblclick="resetZoom"
        >
          <div class="zoom-frame__stage" :style="stageStyle">
            <component
              :is="component"
              v-if="component && !failed"
              :params="spec.params"
              :label="spec.caption || spec.fallback_text"
              :motion="spec.motion"
              :fallback="spec.fallback_text"
            />
          </div>
        </div>
      </div>
      <button ref="zoomClose" class="figure__zoom-close figure__zoom-close--baked" type="button" @click="closeZoom">
        关闭放大
      </button>
    </template>

    <template v-else>
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
    </template>
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
.figure__zoom--scene,
.figure__zoom--baked {
  display: inline-flex;
}

/* ---------- 实物图放大：整页铺开 ---------- */

/* 选择器写成复合类（0,2,0）：单类会被后面那条 `.figure__zoom-layer`
   的深色遮罩按"后出现者胜"盖掉——实测背景仍是 rgba(12,14,18,.82)。 */
.figure__zoom-layer.figure__zoom-layer--baked {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  justify-content: flex-start;
  gap: 0;
  padding: 0;
  background: var(--c-bg);
}

.zoom-frame {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  margin: 0;
  /* 不画整圈边框：图只有 1330 原生宽，画个 1700 的框等于框住一圈空白，
     越看越像"图没铺满"。只留一条分隔线把工具条和画面切开。 */
  border: 0;
  border-bottom: 1px solid var(--c-line-soft);
  background: var(--c-bg);
}

.zoom-frame__bar {
  flex: none;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 0 20px;
  border-bottom: 1px solid var(--c-line);
  background: var(--c-surface);
}

.zoom-frame__label {
  font-family: var(--font-mono);
  font-size: 13px;
  letter-spacing: 0.6px;
  color: var(--c-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.zoom-frame__hint {
  font-size: 11px;
  letter-spacing: 0.4px;
  color: var(--c-ink-3);
  white-space: nowrap;
}

/* 图的容器要能"吃掉"剩余高度：img 的 height:100% 只有在父级高度可解析时才算数。 */
.zoom-frame__body {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 10px;
  /* 滚轮缩放期间不许把滚动传给页面，也不许浏览器接管触摸手势；
     放大后拖动的边界由 clampPan 兜住。 */
  overflow: hidden;
  touch-action: none;
  overscroll-behavior: contain;
}

/* 图片容器：滚轮/拖动只改这一层的 transform，图之外的页面纹丝不动。 */
.zoom-frame__stage {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  will-change: transform;
}

.zoom-frame__body--pannable {
  cursor: grab;
}

.zoom-frame__body--pannable:active {
  cursor: grabbing;
}

/* 放大态：按可用空间等比放到最大（含 1.2–1.3 倍上采样）。
   为什么不再坚持 1:1：本人要的是"能看清、够大"，1330px 的原图在 1728 屏上
   1:1 只剩两边各 200px 白边，视觉上就是"没放大"；这种量级的上采样在
   高质量渲染图上没有可见损失（不是放大照片）。 */
.zoom-frame__body :deep(.baked) {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.figure__zoom-close--baked {
  flex: none;
  align-self: center;
  margin: 12px 0 16px;
  min-height: 40px;
  border: 1px solid var(--c-line);
  background: var(--c-surface);
  color: var(--c-ink);
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
