import { createRouter, createWebHistory } from 'vue-router'
import LibraryView from '../views/LibraryView.vue'

const router = createRouter({
  history: createWebHistory('/apps/electro-assist/'),
  routes: [
    { path: '/', name: 'library', component: LibraryView },
    {
      path: '/new',
      name: 'new',
      // 生成页懒加载：首屏（列表）不需要表单与轮询逻辑。
      component: () => import('../views/NewGuideView.vue'),
    },
    {
      path: '/guide/:id/explore',
      name: 'guide-explore',
      // 探索台（三栏 + 轨迹）：与阅读器同一份数据、同一套加载逻辑，只换版式。
      // 单独成路由是为了让两种版式并存、可对比——确认后再决定谁做默认。
      component: () => import('../views/GuideView.vue'),
      props: true,
      // 三栏栅格需要整幅宽度：外壳的 .container 默认 860px，会把中栏压成一条缝。
      meta: { wide: true },
    },
    {
      path: '/guide/:id',
      name: 'guide',
      // 详情页懒加载：首屏（列表）不需要指导书渲染代码。
      component: () => import('../views/GuideView.vue'),
      props: true,
      // 整页阅读器要吃掉视口宽度：三维场景在 860px 内容列里只能到 320px 宽，
      // 那还不如一张图。宽版只对这一页开放，不改成全站默认。
      meta: { wide: true },
    },
    {
      path: '/run/:sid',
      name: 'run',
      // 现场引导页：只在这里引入判据表单与操作条。
      component: () => import('../views/RunView.vue'),
      props: true,
    },
    {
      path: '/record/:sid',
      name: 'record',
      component: () => import('../views/RecordView.vue'),
      props: true,
    },
    {
      path: '/privacy',
      name: 'privacy',
      // 纯静态说明页：单独 chunk，不进首屏
      component: () => import('../views/PrivacyView.vue'),
    },
    {
      path: '/diagnose',
      name: 'diagnose',
      // B 模块：现场排查。只做检索，页面本身不引入任何模型相关代码。
      component: () => import('../views/DiagnoseView.vue'),
    },
    {
      path: '/demo/device',
      name: 'device-demo',
      // 设备三维演示：Three.js 在该页内部再动态引入，主包与首屏都不受影响。
      component: () => import('../views/DeviceDemoView.vue'),
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
  scrollBehavior(_to, _from, saved) {
    return saved ?? { top: 0 }
  },
})

/* 路由切换后把焦点送回新页的 h1（计划 §12.5）。
 *
 * 为什么必须做：SPA 换页时浏览器不会重置焦点，读屏与键盘用户会停在
 * **上一页**的某个链接上，接着按 Tab 就从半路开始读——在指导书页面里
 * 这等于跳过标题直接进入第 5 步的判据。
 *
 * 两个实现细节：
 * 1) 不能只看 afterEach 那一刻：视图是懒加载的，DOM 还没挂载。这里按帧重试，
 *    最多 20 帧（约 330ms），找不到就放弃——绝不能为了"归位"把页面卡住。
 * 2) h1 默认不可聚焦，补 `tabindex="-1"`（不进入 Tab 序列），
 *    并 `preventScroll` —— 滚动位置由 scrollBehavior 管，两处都滚会跳一下。
 */
let firstNavigation = true

function focusHeading(attempt = 0): void {
  const heading = document.querySelector<HTMLElement>('.page-title, main h1, h1')
  if (heading) {
    if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1')
    heading.focus({ preventScroll: true })
    return
  }
  if (attempt < 20) requestAnimationFrame(() => focusHeading(attempt + 1))
}

router.afterEach((to, _from, failure) => {
  if (failure || !to.name) return
  // 首次进入不做：直接打开页面时抢焦点没有意义，还会让首屏多一个焦点环
  if (firstNavigation) {
    firstNavigation = false
    return
  }
  // 用户已经开始输入（比如自动聚焦的搜索框）就别抢——那是他自己选的落点
  const active = document.activeElement
  if (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return
  requestAnimationFrame(() => focusHeading())
})

export default router
