<script setup lang="ts">
/** 暗色逃生条（计划 §12.3 / 视觉规范 §3.2）。
 *
 *  存在的唯一理由：暗色开关藏在抽屉底部（防现场误触），那就必须给一条
 *  "已经在暗色里、怎么回去"的路。只在现场语境出现——A1 会话页，以及由 A1
 *  转入的 B 会话（`?from=run`）。记录页与选书页不挂：那是要读、要打印的文档语境。
 *
 *  三条硬规矩：
 *  1. sticky + 占文档流，不写 fixed——fixed 会盖住第一张步骤卡；
 *  2. 焦点环用 warning 系，不用主色（在 #FFF4E0 底上像装饰）；
 *  3. 不进打印（`.no-print`），纸面上没有"切换亮色"这回事。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { applyTheme, theme } from '../../lib/theme'

const route = useRoute()

const LEAVING_MS = 120

const shouldShow = computed(() => {
  if (theme.value !== 'dark') return false
  if (route.name === 'run') return true
  return route.name === 'diagnose' && route.query.from === 'run'
})

/** 淡出 120ms 再卸载。
 *  刻意**不用** `<Transition>`：它会把 Vue 的 BaseTransition 整段运行时代码
 *  拖进首屏包（实测 +6.2KB gzip 1.4KB），为一条提示条的淡出付这个代价不值。 */
const leaving = ref(false)
const mounted = computed(() => shouldShow.value || leaving.value)
let timer: number | undefined

watch(shouldShow, (now, before) => {
  if (!before || now) return
  leaving.value = true
  timer = window.setTimeout(() => {
    leaving.value = false
  }, LEAVING_MS)
})

onBeforeUnmount(() => {
  if (timer !== undefined) window.clearTimeout(timer)
})

function backToLight(): void {
  applyTheme('light')
}
</script>

<template>
  <div
    v-if="mounted"
    class="theme-notice no-print"
    :class="{ 'theme-notice--out': leaving }"
    role="status"
    aria-live="polite"
  >
    <span class="theme-notice__icon" aria-hidden="true">!</span>
    <p class="theme-notice__text">现场作业建议切换亮色</p>
    <button class="theme-notice__btn" type="button" @click="backToLight">切回亮色</button>
  </div>
</template>

<style scoped>
.theme-notice {
  position: sticky;
  /* 顶部条高度只读同一个变量：硬编码 48 会在平板断点调高度时浮在条中间。 */
  top: var(--nav-h);
  z-index: 28;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 44px;
  padding: 0 16px;
  background: var(--c-warning-soft);
  border-bottom: 1px solid var(--c-warning-line);
  color: var(--c-warning);
}

.theme-notice__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 12px;
  font-size: 13px;
  font-weight: 700;
  line-height: 1;
}

.theme-notice__text {
  flex: 1;
  margin: 0;
  font-size: 13px;
  font-weight: 500;
}

.theme-notice__btn {
  min-height: var(--tap);
  padding: 0 8px;
  border: none;
  background: transparent;
  color: inherit;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
}

.theme-notice__btn:hover {
  text-decoration: underline;
}

/* 在 #FFF4E0 底上用主色 teal 环对比不足，会被当成装饰。 */
.theme-notice__btn:focus-visible {
  outline: 2px solid var(--c-warning);
  outline-offset: 2px;
}

.theme-notice--out {
  opacity: 0;
  transition: opacity 120ms ease;
}

@media (prefers-reduced-motion: reduce) {
  .theme-notice--out {
    transition: none;
  }
}
</style>
