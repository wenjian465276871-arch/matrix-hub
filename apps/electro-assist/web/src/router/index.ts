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
      path: '/guide/:id',
      name: 'guide',
      // 详情页懒加载：首屏（列表）不需要指导书渲染代码。
      component: () => import('../views/GuideView.vue'),
      props: true,
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
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
  scrollBehavior(_to, _from, saved) {
    return saved ?? { top: 0 }
  },
})

export default router
