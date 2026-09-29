import { createRouter, createWebHashHistory } from 'vue-router';
import PaymentView from './views/PaymentView.vue';

const router = createRouter({
  history: createWebHashHistory(),
  scrollBehavior: () => ({ top: 0 }),
  routes: [
    { path: '/', redirect: '/pay' },
    { path: '/pay', component: PaymentView, meta: { title: '停车缴费' } },
    { path: '/pay/:parkingLotId', component: PaymentView, meta: { title: '停车缴费' } },
    { path: '/history', component: () => import('./views/PaymentHistoryView.vue'), meta: { title: '我的缴费记录' } },
    {
      path: '/result/:id',
      component: () => import('./views/PaymentResultView.vue'),
      meta: { title: '缴费结果' },
    },
    {
      path: '/admin/login',
      component: () => import('./views/AdminLoginView.vue'),
      meta: { title: '管理登录' },
    },
    {
      path: '/admin',
      component: () => import('./views/AdminDashboardView.vue'),
      meta: { title: '停车缴费管理' },
    },
    { path: '/:pathMatch(.*)*', redirect: '/pay' },
  ],
});

export default router;
