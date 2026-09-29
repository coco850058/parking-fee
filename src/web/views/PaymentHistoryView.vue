<template>
  <main class="app-page history-page">
    <van-nav-bar
      title="我的缴费记录"
      left-arrow
      safe-area-inset-top
      @click-left="router.replace(backRoute)"
    />

    <div class="history-content">
      <section class="history-hero">
        <span class="history-hero-icon" aria-hidden="true"><van-icon name="orders-o" /></span>
        <div>
          <h1>我的缴费记录</h1>
          <p>查看当前微信账号已支付和已退款的订单</p>
        </div>
      </section>

      <div v-if="loading && orders.length === 0" class="history-skeletons">
        <div v-for="index in 3" :key="index" class="surface-card history-skeleton">
          <van-skeleton title :row="3" />
        </div>
      </div>

      <div v-else-if="error && orders.length === 0" class="surface-card history-feedback">
        <van-icon name="warning-o" size="34" color="#9a6700" />
        <h2>暂时无法查看缴费记录</h2>
        <p>{{ error }}</p>
        <van-button round type="primary" class="touch-button" @click="loadInitial">重新加载</van-button>
      </div>

      <div v-else-if="orders.length === 0" class="surface-card history-feedback">
        <van-icon name="orders-o" size="42" color="#0071dc" />
        <h2>还没有缴费记录</h2>
        <p>支付成功后，记录会显示在这里。</p>
        <van-button round type="primary" class="touch-button" @click="router.replace(backRoute)">
          去缴费
        </van-button>
      </div>

      <template v-else>
        <div class="history-list-head">
          <span>共 {{ total }} 条缴费记录</span>
          <button type="button" :disabled="loading" @click="loadInitial">
            <van-icon name="replay" /> 刷新
          </button>
        </div>

        <div class="history-list">
          <button
            v-for="item in orders"
            :key="item.id"
            type="button"
            class="surface-card history-card"
            @click="openOrder(item)"
          >
            <div class="history-card-head">
              <strong>{{ item.plateNumber }}</strong>
              <span :class="['status-pill', historyStatusTone(item)]">{{ historyStatusText(item) }}</span>
            </div>
            <p>{{ customerTypeText[item.customerType] }} · {{ durationText[item.durationMonths] }}</p>
            <p v-if="item.parkingLotName" class="history-lot-name">
              <van-icon name="location-o" /> {{ item.parkingLotName }}
            </p>
            <p class="history-address"><van-icon name="location-o" /> {{ item.address }}</p>
            <p
              v-if="item.refund?.status === 'closed' || item.refund?.status === 'abnormal'"
              class="history-refund-note"
            >
              退款未完成，请联系管理方核查。
            </p>
            <div class="history-card-foot">
              <span>{{ formatDateTime(item.paidAt || item.createdAt) }}</span>
              <strong class="amount-value">¥{{ formatMoney(item.amount) }}</strong>
            </div>
          </button>
        </div>

        <div class="history-list-footer">
          <p v-if="error" class="history-more-error">{{ error }}</p>
          <van-button
            v-if="orders.length < total"
            plain
            round
            block
            type="primary"
            class="touch-button"
            :loading="loading"
            @click="loadMore"
          >
            {{ error ? '重试加载' : '加载更多' }}
          </van-button>
          <p v-else class="history-list-end">已显示全部记录</p>
        </div>
      </template>
    </div>
  </main>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { publicApi } from '../api';
import type { Order } from '../types';
import { customerTypeText, durationText, formatDateTime, formatMoney } from '../utils';

const router = useRouter();
const route = useRoute();
const OAUTH_RETURN_KEY = 'park-fee:oauth-return-history';
const OAUTH_RETURN_ENTRY_KEY = 'park-fee:oauth-return-history-entry';
const returnParkingLotId = computed(() => typeof route.query.parkingLotId === 'string'
  ? route.query.parkingLotId
  : '');
const returnDirect = computed(() => route.query.entry === 'direct');
const backRoute = computed(() => returnParkingLotId.value
  ? returnDirect.value
    ? `/pay?parkingLotId=${encodeURIComponent(returnParkingLotId.value)}`
    : `/pay/${encodeURIComponent(returnParkingLotId.value)}`
  : '/pay');
const orders = ref<Order[]>([]);
const total = ref(0);
const page = ref(1);
const loading = ref(false);
const error = ref('');
const sessionReady = ref(false);
let requestId = 0;

function historyStatusText(order: Order) {
  if (order.status === 'refunded') return '已退款';
  if (order.refund?.status === 'requesting' || order.refund?.status === 'processing') {
    return '退款处理中';
  }
  if (order.refund?.status === 'closed' || order.refund?.status === 'abnormal') {
    return '退款未完成';
  }
  return '已支付';
}

function historyStatusTone(order: Order) {
  if (order.status === 'refunded') return 'info';
  if (order.refund?.status === 'requesting' || order.refund?.status === 'processing') {
    return 'warning';
  }
  if (order.refund?.status === 'closed' || order.refund?.status === 'abnormal') {
    return 'muted';
  }
  return 'success';
}

async function ensureSession() {
  if (sessionReady.value) return true;
  const searchParams = new URLSearchParams(window.location.search);
  const hashQuery = window.location.hash.includes('?')
    ? new URLSearchParams(window.location.hash.slice(window.location.hash.indexOf('?') + 1))
    : new URLSearchParams();
  const code = searchParams.get('code') || hashQuery.get('code') || undefined;
  const state = searchParams.get('state') || hashQuery.get('state') || undefined;
  const session = await publicApi.session({ code, state });

  if (session.oauthRequired) {
    if (code || state) throw new Error('微信身份验证未完成，请返回微信重新打开缴费二维码');
    if (!session.authorizationUrl) throw new Error('请在微信内打开缴费二维码');
    try {
      sessionStorage.setItem(OAUTH_RETURN_KEY, returnParkingLotId.value || '1');
      if (returnDirect.value) sessionStorage.setItem(OAUTH_RETURN_ENTRY_KEY, 'direct');
      else sessionStorage.removeItem(OAUTH_RETURN_ENTRY_KEY);
    } catch {
      // 浏览器禁用会话存储时，授权完成后仍可从缴费页进入记录。
    }
    window.location.replace(session.authorizationUrl);
    return false;
  }

  if (code || state) {
    const params = new URLSearchParams();
    if (returnParkingLotId.value) params.set('parkingLotId', returnParkingLotId.value);
    if (returnDirect.value) params.set('entry', 'direct');
    const query = params.size ? `?${params}` : '';
    window.history.replaceState({}, document.title, `${window.location.pathname}#/history${query}`);
  }
  sessionReady.value = true;
  return true;
}

async function loadPage(reset: boolean) {
  if (loading.value) return;
  const currentRequest = ++requestId;
  loading.value = true;
  error.value = '';
  if (reset) {
    page.value = 1;
    total.value = 0;
    orders.value = [];
  }
  try {
    if (!(await ensureSession())) return;
    const result = await publicApi.orderHistory(page.value, 20);
    if (currentRequest !== requestId) return;
    const visible = result.items.filter(
      (order) => order.status === 'paid' || order.status === 'refunded',
    );
    orders.value = reset ? visible : [...orders.value, ...visible];
    total.value = result.total;
    page.value = result.page + 1;
  } catch (reason) {
    if (currentRequest !== requestId) return;
    error.value = reason instanceof Error ? reason.message : '缴费记录加载失败，请稍后重试';
  } finally {
    if (currentRequest === requestId) loading.value = false;
  }
}

function loadInitial() {
  void loadPage(true);
}

function loadMore() {
  void loadPage(false);
}

function openOrder(order: Order) {
  void router.push({
    path: `/result/${order.id}`,
    query: {
      from: 'history',
      ...(returnParkingLotId.value ? { parkingLotId: returnParkingLotId.value } : {}),
      ...(returnDirect.value ? { entry: 'direct' } : {}),
    },
  });
}

onMounted(loadInitial);
</script>

<style scoped>
.history-page :deep(.van-nav-bar) {
  border-bottom: 1px solid var(--line);
}

.history-page :deep(.van-nav-bar__arrow) {
  color: var(--ink);
  font-size: 20px;
}

.history-content {
  display: grid;
  gap: 12px;
  padding: 14px;
}

.history-hero {
  display: flex;
  min-height: 104px;
  align-items: center;
  gap: 13px;
  padding: 17px;
  border-radius: 18px;
  color: #fff;
  background:
    radial-gradient(circle at 94% -8%, rgba(255, 255, 255, 0.17) 0 75px, transparent 76px),
    linear-gradient(135deg, var(--brand-dark), var(--brand));
}

.history-hero-icon {
  display: grid;
  flex: 0 0 45px;
  height: 45px;
  place-items: center;
  border-radius: 14px;
  color: var(--accent);
  background: rgba(0, 53, 100, 0.3);
  font-size: 25px;
}

.history-hero h1,
.history-hero p {
  margin: 0;
}

.history-hero h1 {
  font-size: 18px;
}

.history-hero p {
  margin-top: 6px;
  color: rgba(255, 255, 255, 0.82);
  font-size: 11px;
  line-height: 1.45;
}

.history-skeletons,
.history-list {
  display: grid;
  gap: 11px;
}

.history-skeleton {
  padding: 19px 15px;
}

.history-feedback {
  display: flex;
  min-height: 290px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 22px;
  text-align: center;
}

.history-feedback h2 {
  margin: 13px 0 0;
  font-size: 18px;
}

.history-feedback p {
  margin: 8px 0 18px;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.5;
}

.history-list-head,
.history-card-head,
.history-card-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 9px;
}

.history-list-head {
  min-height: 29px;
  padding: 0 2px;
  color: var(--muted);
  font-size: 12px;
}

.history-list-head button {
  min-height: 35px;
  padding: 0 8px;
  border: 0;
  color: var(--brand);
  background: transparent;
  font-weight: 600;
}

.history-list-head button:disabled {
  opacity: 0.45;
}

.history-card {
  width: 100%;
  padding: 15px;
  color: var(--ink);
  text-align: left;
}

.history-card-head strong {
  font-size: 19px;
  letter-spacing: 0.04em;
}

.history-card > p {
  margin: 10px 0 0;
  color: #5e6267;
  font-size: 12px;
}

.history-address {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history-address .van-icon {
  color: var(--brand);
}

.history-card > .history-lot-name {
  color: var(--brand-dark);
  font-weight: 600;
}

.history-card > .history-refund-note {
  color: #9a6700;
}

.history-card-foot {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid #eceeef;
}

.history-card-foot span {
  color: var(--muted);
  font-size: 11px;
}

.history-card-foot strong {
  color: var(--brand-dark);
  font-size: 19px;
}

.history-list-footer {
  padding: 3px 0 max(16px, env(safe-area-inset-bottom));
}

.history-more-error,
.history-list-end {
  color: var(--muted);
  font-size: 12px;
  text-align: center;
}

.history-more-error {
  color: var(--danger);
}
</style>
