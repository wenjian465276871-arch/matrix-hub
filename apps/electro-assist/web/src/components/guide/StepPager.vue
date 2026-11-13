<script setup lang="ts">
/** 整页翻页阅读器：一步一屏，左滑/右滑或点按钮翻页。
 *
 *  ## 为什么用 scroll-snap，而不是自己算 transform
 *  1. **CSP**：本站 `style-src 'self'`，内联 style 会被浏览器拒掉。用 `transform:
 *     translateX(...)` 就必须把位移写进 style 属性——在开发机上正常，线上整页不动。
 *     scroll-snap 的位移全部由浏览器的滚动位置决定，不碰 style。
 *  2. **手势**：原生横向滚动自带惯性、边缘回弹与「滑到一半松手」的吸附，
 *     自己写的 pointer 拖拽要重新实现一遍，而且会和三维画布抢指针事件。
 *  3. **可访问性**：滚动容器天然可聚焦、可用键盘与读屏滚动；自绘的 transform 方案
 *     要手动补 `aria-hidden`、焦点管理和滚动条语义。
 *
 *  ## 只挂当前页与左右各一页
 *  三维场景每挂一个就是一个 WebGL 上下文（浏览器上限通常 8 个）。8 步的指导书里
 *  若每步都有图，全量挂载会直接撞上限，后面的画布变成空白。所以页面**壳**始终在
 *  DOM 里（滚动几何才成立），页面**内容**只在 `current ± 1` 时渲染。
 *
 *  ## 翻页控件不在这个组件里
 *  `PagerNav` 把「‹ 3/9 › + 圆点」渲染到阅读器顶栏，与标题同一行。
 *  上一版是第二级工具栏，凭空吃掉 53px 垂直空间——那正是三维最需要的高度。
 *
 *  ## 打印
 *  打印时必须把全部页铺开（`preparePrint()` → 等一帧 → 调 `window.print()`），
 *  否则纸上只有当前一页。`Ctrl+P` 走 `beforeprint` 兜底，尽力而为。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, provide, ref, useSlots, watch } from 'vue'
import StepPage from './StepPage.vue'
import { announce } from '../../lib/announce'
import {
  clampPage,
  loadPage,
  pageCount,
  pageIndexFromScroll,
  pageLabels,
  pageStorageKey,
  savePage,
} from '../../lib/paging'
import type { Step } from '../../types'

const props = defineProps<{
  guideId: string
  steps: Step[]
  status: 'draft' | 'published'
  numbers: Record<string, number>
  /** 是否有尾页（未归入步骤的现场素材）。不传则按插槽是否存在判断——
   *  但 `v-if` 包着的插槽在父组件里"存在但为空"，页数会多算一页，所以显式传。 */
  tail?: boolean
}>()

/** 当前页（0 = 封面，1..N = 步骤，N+1 = 尾页）。父组件用 v-model:current 接管。 */
const current = defineModel<number>('current', { default: 0 })

const slots = useSlots()
const hasTail = computed(() => props.tail ?? Boolean(slots.tail))
const count = computed(() => pageCount(props.steps.length, hasTail.value))

const track = ref<HTMLDivElement | null>(null)
const printing = ref(false)

/** 页面壳一直在，内容按需渲染：见文件头「只挂当前页与左右各一页」。 */
function near(index: number): boolean {
  return printing.value || Math.abs(index - current.value) <= 1
}

const labels = computed(() => pageLabels(props.steps, hasTail.value))

/** 滚动位置 → 当前页。半页四舍五入，见 `paging.ts` 的注释。 */
function syncFromScroll(): void {
  const el = track.value
  if (!el || printing.value) return
  const index = pageIndexFromScroll(el.scrollLeft, el.clientWidth, count.value)
  if (index !== current.value) {
    current.value = index
    savePage(pageStorageKey(props.guideId), index)
  }
}

/**
 * 给操作台一个"点 MON 屏去确认"的钩子。
 *
 * 页码口径是 `1 + steps + 尾页`（0 = 封面），所以第 i 步在 `i + 1`。
 * provide 放在这里而不是 StepPage：一页一个组件，而跳转要由分页器执行。
 */
provide('guide-goto-mon', () => {
  const index = props.steps.findIndex((s) =>
    (s.figures ?? []).some((f) => f.primitive === 'mon_panel'),
  )
  if (index < 0) return false
  goTo(index + 1)
  return true
})

function goTo(index: number, smooth = true): void {
  const target = clampPage(index, count.value)
  current.value = target
  savePage(pageStorageKey(props.guideId), target)
  const el = track.value
  if (!el) return
  const left = target * el.clientWidth
  // 已经在这一页就别再滚：会把用户的惯性手势打断
  if (Math.abs(el.scrollLeft - left) < 2) return
  // `?.`：happy-dom / 极老浏览器没有 scrollTo，缺了它单测会直接抛
  el.scrollTo?.({ left, behavior: smooth ? 'smooth' : 'auto' })
  announce(`${labels.value[target] ?? ''}（第 ${target + 1} 页，共 ${count.value} 页）`)
}

function onScroll(): void {
  // 滚动事件按帧合并：event 频率远高于渲染帧，逐条算会拖慢拖拽
  if (raf) return
  raf = requestAnimationFrame(() => {
    raf = 0
    syncFromScroll()
  })
}
let raf = 0

function onKey(event: KeyboardEvent): void {
  const key = event.key
  if (key === 'ArrowRight' || key === 'PageDown') {
    event.preventDefault()
    goTo(current.value + 1)
  } else if (key === 'ArrowLeft' || key === 'PageUp') {
    event.preventDefault()
    goTo(current.value - 1)
  } else if (key === 'Home') {
    event.preventDefault()
    goTo(0)
  } else if (key === 'End') {
    event.preventDefault()
    goTo(count.value - 1)
  }
}

/* 宽度变化（旋转屏幕、开抽屉）后必须重新对齐，否则会停在一半的位置 */
let observer: ResizeObserver | null = null

function realign(): void {
  const el = track.value
  if (!el) return
  el.scrollTo?.({ left: current.value * el.clientWidth, behavior: 'auto' })
}

watch(count, () => {
  current.value = clampPage(current.value, count.value)
})

watch(current, (value) => {
  const el = track.value
  if (!el) return
  const left = clampPage(value, count.value) * el.clientWidth
  // 差值小于半个页宽说明是「滚动过程中同步过来的」，不要再发一次滚动
  if (Math.abs(el.scrollLeft - left) < el.clientWidth / 2) return
  el.scrollTo?.({ left, behavior: 'smooth' })
})

/** 打印：先把全部页铺开（内容才渲染），再交给浏览器。 */
async function preparePrint(): Promise<void> {
  printing.value = true
  await nextTick()
  // 三维场景是异步初始化的：给一帧时间把 canvas 建起来。
  // 建不起来也不会打白框——DeviceFigure 有文字兜底。
  await new Promise((resolve) => window.setTimeout(resolve, 900))
}

function onBeforePrint(): void {
  printing.value = true
}

function onAfterPrint(): void {
  printing.value = false
}

onMounted(async () => {
  current.value = loadPage(pageStorageKey(props.guideId), count.value)
  await nextTick()
  realign()
  // ResizeObserver 在 happy-dom 里不存在；缺了它不该让整页挂掉
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(realign)
    if (track.value) observer.observe(track.value)
  }
  window.addEventListener('beforeprint', onBeforePrint)
  window.addEventListener('afterprint', onAfterPrint)
})

onBeforeUnmount(() => {
  if (raf) cancelAnimationFrame(raf)
  observer?.disconnect()
  observer = null
  window.removeEventListener('beforeprint', onBeforePrint)
  window.removeEventListener('afterprint', onAfterPrint)
})

defineExpose({ goTo, preparePrint })
</script>

<template>
  <div class="pager" :class="{ 'pager--print': printing }">
    <!-- eslint-disable-next-line vue/no-template-shadow -->
    <div
      ref="track"
      class="pager__track"
      tabindex="0"
      role="region"
      aria-roledescription="分页阅读"
      :aria-label="`指导书分页阅读，共 ${count} 页，左右滑动翻页`"
      @keydown="onKey"
      @scroll.passive="onScroll"
    >
      <div
        class="pager__page"
        :aria-hidden="current !== 0 ? 'true' : undefined"
        :inert="current !== 0"
      >
        <slot name="cover" />
      </div>

      <div
        v-for="(step, i) in steps"
        :key="step.id"
        class="pager__page"
        role="group"
        aria-roledescription="步骤"
        :aria-label="`第 ${step.seq} 步，共 ${steps.length} 步：${step.title}`"
        :aria-hidden="current !== i + 1 ? 'true' : undefined"
        :inert="current !== i + 1"
      >
        <StepPage
          v-if="near(i + 1)"
          :step="step"
          :total="steps.length"
          :numbers="numbers"
          :status="status"
        />
      </div>

      <div
        v-if="hasTail"
        class="pager__page"
        :aria-hidden="current !== count - 1 ? 'true' : undefined"
        :inert="current !== count - 1"
      >
        <slot name="tail" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.pager {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}

/* ---------- 页轨 ---------- */

.pager__track {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  overflow-x: auto;
  overflow-y: hidden;
  scroll-snap-type: x mandatory;
  /* 滑到头不要带着整页回弹 */
  overscroll-behavior-x: contain;
  scrollbar-width: none;
  background: var(--c-bg);
}

.pager__track::-webkit-scrollbar {
  display: none;
}

.pager__track:focus-visible {
  outline: 2px solid var(--c-primary);
  outline-offset: -2px;
}

.pager__page {
  flex: 0 0 100%;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  scroll-snap-align: start;
  scroll-snap-stop: always;
  background: var(--c-surface);
}

/* ---------- 打印：全部页铺开 ---------- */

.pager--print .pager__track {
  display: block;
  overflow: visible;
  height: auto;
}

.pager--print .pager__page {
  height: auto;
  min-height: 0;
  break-after: page;
  page-break-after: always;
  scroll-snap-align: none;
}

.pager--print .pager__page:last-child {
  break-after: auto;
  page-break-after: auto;
}
</style>
