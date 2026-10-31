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
const zoomTrigger = ref<HTMLButtonElement | null>(null)
const zoomClose = ref<HTMLButtonElement | null>(null)

async function openZoom(): Promise<void> {
  zoomed.value = true
  document.documentElement.classList.add('is-figure-zoom')
  await nextTick()
  zoomClose.value?.focus()
}

function closeZoom(): void {
  if (!zoomed.value) return
  zoomed.value = false
  document.documentElement.classList.remove('is-figure-zoom')
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
  <figure class="figure">
    <figcaption v-if="spec.caption" class="figure__caption">{{ spec.caption }}</figcaption>
    <component
      :is="component"
      v-if="component && !failed"
      :params="spec.params"
      :label="spec.caption || spec.fallback_text"
      :motion="spec.motion"
    />
    <p v-else class="figure__fallback">{{ spec.fallback_text }}</p>
    <p v-if="failed" class="figure__pending">{{ reason }} · 已降级为文字</p>

    <!-- 只在横屏短高出现：竖屏的图够大，多一个按钮只是噪音 -->
    <button ref="zoomTrigger" class="figure__zoom" type="button" @click="openZoom">
      点击放大
    </button>
  </figure>

  <div
    v-if="zoomed"
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
