import { createRouter, createWebHistory } from 'vue-router'
import LibraryView from '../views/LibraryView.vue'

const router = createRouter({
  history: createWebHistory('/apps/electro-assist/'),
  routes: [
    {
      path: '/',
      name: 'library',
      component: LibraryView,
      // 作业库也是两栏工作台（目录 + 列表）：860 的内容列装不下，
      // 否则右侧会空出一大条，与指导书页的三栏语言断层。
      meta: { wide: true, ownFoot: true },
    },
    {
      path: '/new',
      name: 'new',
      // 生成页懒加载：首屏（列表）不需要表单与轮询逻辑。
      component: () => import('../views/NewGuideView.vue'),
    },
    {
      path: '/guide/:id',
      name: 'guide',
      // 指导书**默认就是探索台版式**（2026-11-11 本人裁决：不再有"点阅读进度
      // 才进得来"的第二套风格）。同一份数据、同一套加载逻辑，只换排布。
      component: () => import('../views/GuideView.vue'),
      props: true,
      // 三栏栅格需要整幅宽度；同时**不要页脚**：工作台是 100dvh 定高的，
      // 页脚会把文档撑得比视口高 80px，右侧多出一条永远滚不动的滚动条。
      meta: { wide: true, ownFoot: true },
    },
    {
      path: '/guide/:id/read',
      name: 'guide-read',
      // 分页阅读器保留为**打印/草稿编辑**工作台：纸上要一步一页，
      // 编辑要能看到全篇字段。它是"另一种介质"，不是另一种风格，
      // 界面上只有探索台的「打印视图」入口指向这里。
      component: () => import('../views/GuideView.vue'),
      props: true,
      meta: { wide: true, ownFoot: true },
    },
    {
      // 旧链接兼容：曾经 /explore 是探索台，现在它就是默认页。
      path: '/guide/:id/explore',
      redirect: (to) => ({ name: 'guide', params: { id: to.params.id } }),
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
