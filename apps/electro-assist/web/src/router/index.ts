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
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
  scrollBehavior(_to, _from, saved) {
    return saved ?? { top: 0 }
  },
})

export default router
