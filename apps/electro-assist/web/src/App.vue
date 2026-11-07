<script setup lang="ts">
/** 全站骨架：48px 深色条 + 全屏抽屉。
 *
 *  导航取舍（计划 §12.4）：桌面顶部条内联链接；窄屏只留品牌 + ⋯，
 *  其余入口收进抽屉。**不做底部 tab**——A1 的 48px 操作条要独占拇指区。
 *
 *  抽屉异步加载（`defineAsyncComponent`）：首屏只需要那个按钮，
 *  菜单的模板不该占首屏体积。外观开关也只放在抽屉里（视觉规范 §6）——
 *  放页头会让人在作业中误触变暗，再想切回来还得翻菜单。
 */
import { defineAsyncComponent, ref, watch } from 'vue'
import { RouterLink, RouterView, useRoute } from 'vue-router'
import LiveRegion from './components/ui/LiveRegion.vue'

const SiteDrawer = defineAsyncComponent(() => import('./components/ui/SiteDrawer.vue'))

const route = useRoute()
const drawerOpen = ref(false)
const trigger = ref<HTMLButtonElement | null>(null)

function open(): void {
  drawerOpen.value = true
}

function close(restoreFocus = true): void {
  if (!drawerOpen.value) return
  drawerOpen.value = false
  // 触发键常驻在导航条上，直接还焦点；不上 body 会丢掉键盘位置。
  // 但**路由跳转时不能还**：焦点要交给新页的 h1（router/index.ts），
  // 这里抢回来再被抢走，键盘用户会听到两次位置播报。
  if (restoreFocus) trigger.value?.focus()
}

// 点链接跳走后必须关层：不关的话新页面被抽屉盖住，看起来像"点了没反应"
watch(
  () => route.fullPath,
  () => close(false),
)
</script>

<template>
  <!-- 播报区必须在页面加载时就存在（计划 §12.5）：后插入的 aria-live
       容器，部分读屏不会播报它的第一次内容。 -->
  <LiveRegion />

  <header class="site-nav">
    <div class="nav-inner">
      <RouterLink class="brand" to="/">
        <span class="brand-full">电气调试 AI 作业助手</span>
        <span class="brand-short">AI 作业助手</span>
      </RouterLink>
      <span class="nav-spacer" />
      <nav class="nav-links" aria-label="主导航">
        <RouterLink class="nav-link" to="/new">生成指导书</RouterLink>
        <RouterLink class="nav-link" to="/diagnose">故障排查</RouterLink>
        <a class="nav-link" href="/">返回门户</a>
      </nav>
      <button
        ref="trigger"
        class="nav-more"
        type="button"
        aria-haspopup="dialog"
        :aria-controls="drawerOpen ? 'site-drawer' : undefined"
        :aria-expanded="drawerOpen"
        @click="open"
      >
        <span aria-hidden="true">⋯</span>
        <span class="sr-only">打开菜单</span>
      </button>
    </div>
  </header>

  <main class="container">
    <RouterView />
  </main>

  <footer class="site-foot">
    演示数据 · 非实际作业依据 · AI 生成内容需专业人员复核 ·
    <RouterLink class="site-foot__link" to="/privacy">隐私与数据</RouterLink>
  </footer>

  <SiteDrawer v-if="drawerOpen" @close="close" />
</template>

<style scoped>
.nav-links {
  display: flex;
  align-items: center;
  gap: 16px;
}

.nav-more {
  width: var(--tap);
  height: var(--tap);
  padding: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: #fff;
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
}

.site-foot__link {
  /* 2026-11-07 axe 实测：原 rgba(255,255,255,.72) 是照深色导航条写的，
     复制到浅底页脚后对比度约 1.1:1（8/8 扫描全红）。改用语义令牌，
     浅色 #3d4a52 对 #F6F8F9 ≈ 8:1，暗色自动跟随。 */
  color: var(--c-ink-2);
  text-decoration: underline;
  text-underline-offset: 3px;
}

.site-foot__link:hover {
  color: var(--c-ink);
}

.nav-more:hover {
  background: rgba(255, 255, 255, 0.12);
}

.nav-more:focus-visible {
  outline: 2px solid #fff;
  outline-offset: 2px;
}

@media (max-width: 719px) {
  .nav-links {
    display: none;
  }
}
</style>
