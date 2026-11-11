<script setup lang="ts">
/** 全站骨架：88px 单条顶栏 + 全屏抽屉。
 *
 *  2026-11-11 换版（本人指定"全站保持参考站同一套风格"）：原来「48px 深色导航
 *  + 页内白条」两层并叠，是同一条信息付两次垂直空间；现在只剩 TopBar 一条，
 *  页面通过 composables/useTopBar 把自己的"正在查看/标题/进度"投进去，
 *  **不允许**再自己画一条头。
 *
 *  抽屉异步加载（`defineAsyncComponent`）：首屏只需要那个按钮，
 *  菜单的模板不该占首屏体积。外观开关也只放在抽屉里（视觉规范 §6）——
 *  放页头会让人在作业中误触变暗，再想切回来还得翻菜单。
 */
import { defineAsyncComponent, ref, watch } from 'vue'
import { RouterLink, RouterView, useRoute } from 'vue-router'
import LiveRegion from './components/ui/LiveRegion.vue'
import TopBar from './components/shell/TopBar.vue'

const SiteDrawer = defineAsyncComponent(() => import('./components/ui/SiteDrawer.vue'))

const route = useRoute()
const drawerOpen = ref(false)

function open(): void {
  drawerOpen.value = true
}

function close(restoreFocus = true): void {
  if (!drawerOpen.value) return
  drawerOpen.value = false
  // 触发键常驻在顶栏上，直接还焦点；不上 body 会丢掉键盘位置。
  // 但**路由跳转时不能还**：焦点要交给新页的 h1（router/index.ts），
  // 这里抢回来再被抢走，键盘用户会听到两次位置播报。
  // 顶栏在子组件里，拿不到 template ref，用 id 取（全站只有一个）。
  if (restoreFocus) document.getElementById('nav-more')?.focus()
}

// 点链接跳走后必须关层：不关的话新页面被抽屉盖住，看起来像"点了没反应"
watch(
  () => route.fullPath,
  () => close(false),
)

/* 跳转链接原生行为只改 hash，Chrome 不一定把焦点交给带 tabindex=-1 的 main，
   结果下一次 Tab 又回到跳转链接。这里显式聚焦，键盘路径才真的"跳过去了"。 */
function skipToMain(): void {
  requestAnimationFrame(() => {
    document.getElementById('main')?.focus()
  })
}
</script>

<template>
  <!-- 播报区必须在页面加载时就存在（计划 §12.5）：后插入的 aria-live
       容器，部分读屏不会播报它的第一次内容。 -->
  <LiveRegion />

  <a class="skip-link" href="#main" @click="skipToMain">跳到主要内容</a>

  <TopBar :on-more="open" :more-open="drawerOpen" />

  <main id="main" class="container" :class="{ 'container--wide': route.meta.wide }" tabindex="-1">
    <RouterView />
  </main>

  <footer v-if="!route.meta.ownFoot" class="site-foot">
    演示数据 · 非实际作业依据 · AI 生成内容需专业人员复核 ·
    <RouterLink class="site-foot__link" to="/privacy">隐私与数据</RouterLink>
  </footer>

  <SiteDrawer v-if="drawerOpen" @close="close" />
</template>

<style scoped>
/* 键盘用户第一个 Tab 就能跳过导航直达正文（计划 §12.5「全键盘可操作」）。
   平时移出视口，聚焦时贴左上角；打印不参与。 */
.skip-link {
  position: fixed;
  top: 8px;
  left: 8px;
  z-index: 100;
  padding: 10px 14px;
  border: 2px solid var(--c-primary);
  border-radius: var(--radius-sm);
  background: var(--c-surface);
  color: var(--c-ink);
  font-size: 14px;
  text-decoration: none;
  transform: translateY(-200%);
}

.skip-link:focus-visible {
  transform: translateY(0);
}

@media print {
  .skip-link {
    display: none;
  }
}

.site-foot__link {
  color: var(--c-ink-2);
  text-decoration: underline;
  text-underline-offset: 3px;
}

.site-foot__link:hover {
  color: var(--c-ink);
}
</style>
