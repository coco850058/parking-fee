<template>
  <main class="app-page result-page">
    <van-nav-bar title="缴费结果" left-arrow safe-area-inset-top @click-left="router.replace(backRoute)" />

    <div class="result-shell">
      <div v-if="loading && !order" class="surface-card result-loading">
        <van-loading color="#0071dc" size="30" />
        <span>正在确认支付结果…</span>
      </div>

      <div v-else-if="error && !order" class="surface-card result-error">
        <van-icon name="warning-o" size="42" color="#9a6700" />
        <h1>查询失败</h1>
        <p>{{ error }}</p>
        <van-button round type="primary" class="touch-button" @click="refresh(true)">
          重新查询
        </van-button>
      </div>

      <template v-else-if="order">
        <section class="surface-card result-status" :class="`is-${order.status}`">
          <div class="status-icon" aria-hidden="true">
            <van-icon :name="resultIcon" />
          </div>
          <h1>{{ resultTitle }}</h1>
          <p>{{ resultDescription }}</p>
          <div class="result-amount amount-value">
            <small>¥</small>{{ formatMoney(order.amount) }}
          </div>

          <div v-if="order.status === 'pending'" class="checking-row">
            <van-loading v-if="polling" size="14" color="#6d4d00" />
            <van-icon v-else name="clock-o" />
            <span>{{ polling ? '正在自动查询支付结果' : '自动查询已暂停，可手动刷新' }}</span>
          </div>
        </section>

        <van-notice-bar
          v-if="route.query.payment === 'cancel' && order.status === 'pending'"
          class="cancel-notice"
          color="#6d4d00"
          background="#fff5cc"
          left-icon="info-o"
          text="你已取消本次支付，订单尚未支付"
          wrapable
        />
        <van-notice-bar
          v-else-if="route.query.payment === 'error' && order.status === 'pending'"
          class="cancel-notice"
          color="#6d4d00"
          background="#fff5cc"
          left-icon="info-o"
          text="支付窗口未正常返回，系统正在自动核对结果，请勿重复提交"
          wrapable
        />
        <van-notice-bar
          v-if="order.status === 'paid' && order.refund && ['requesting', 'processing'].includes(order.refund.status)"
          class="cancel-notice"
          color="#6d4d00"
          background="#fff5cc"
          left-icon="info-o"
          text="退款申请正在处理中；微信确认成功后，订单才会显示已退款"
          wrapable
        />
        <van-notice-bar
          v-else-if="order.status === 'paid' && order.refund && ['closed', 'abnormal'].includes(order.refund.status)"
          class="cancel-notice"
          color="#6d4d00"
          background="#fff5cc"
          left-icon="info-o"
          text="退款未完成，请联系管理方核查退款状态"
          wrapable
        />

        <section class="surface-card receipt-card">
          <div class="receipt-head">
            <div>
              <span>缴费凭证</span>
              <small>电子记录</small>
            </div>
            <span :class="['status-pill', statusTone[order.status]]">
              {{ statusText[order.status] }}
            </span>
          </div>

          <dl class="receipt-list">
            <div v-if="order.parkingLotName">
              <dt>停车场</dt>
              <dd>{{ order.parkingLotName }}</dd>
            </div>
            <div>
              <dt>车牌号</dt>
              <dd class="plate-text">{{ order.plateNumber }}</dd>
            </div>
            <div>
              <dt>缴费身份</dt>
              <dd>{{ customerTypeText[order.customerType] }}</dd>
            </div>
            <div>
              <dt>缴费时长</dt>
              <dd>{{ durationText[order.durationMonths] }}</dd>
            </div>
            <div>
              <dt>地址</dt>
              <dd>{{ order.address }}</dd>
            </div>
            <div>
              <dt>创建时间</dt>
              <dd>{{ formatDateTime(order.createdAt) }}</dd>
            </div>
            <div v-if="order.paidAt">
              <dt>支付时间</dt>
              <dd>{{ formatDateTime(order.paidAt) }}</dd>
            </div>
            <div>
              <dt>订单号</dt>
              <dd class="order-number">
                <span>{{ order.orderNo }}</span>
                <button type="button" aria-label="复制订单号" @click="copyOrderNo">
                  <van-icon name="description" />
                </button>
              </dd>
            </div>
            <div v-if="order.transactionId">
              <dt>微信支付单号</dt>
              <dd class="break-value">{{ order.transactionId }}</dd>
            </div>
          </dl>

          <div class="receipt-foot">
            <van-icon name="shield-o" /> 此凭证由系统生成，可截图留存
          </div>
        </section>

        <div class="result-actions safe-bottom">
          <van-button
            v-if="order.status === 'pending' && order.paymentParams"
            round
            type="primary"
            class="touch-button"
            :loading="paying"
            @click="continuePay"
          >
            继续支付
          </van-button>
          <van-button
            v-if="order.status === 'pending'"
            round
            :type="order.paymentParams ? 'default' : 'primary'"
            class="touch-button"
            :loading="refreshing"
            @click="refresh(true)"
          >
            手动刷新结果
          </van-button>
          <template v-else>
            <van-button
              round
              type="primary"
              class="touch-button"
              @click="router.replace(backRoute)"
            >
              {{ route.query.from === 'history' ? '返回缴费记录' : '完成' }}
            </van-button>
            <van-button
              v-if="route.query.from !== 'history' && (order.status === 'paid' || order.status === 'refunded')"
              round
              plain
              type="primary"
              class="touch-button"
              @click="router.push(historyRoute)"
            >
              我的缴费记录
            </van-button>
          </template>
        </div>
      </template>
    </div>
  </main>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { closeToast, showFailToast, showLoadingToast, showSuccessToast, showToast } from 'vant';
import { publicApi } from '../api';
import type { Order } from '../types';
import {
  customerTypeText,
  durationText,
  formatDateTime,
  formatMoney,
  invokeWechatPay,
  statusText,
  statusTone,
} from '../utils';

const route = useRoute();
const router = useRouter();
const order = ref<Order>();
const loading = ref(true);
const refreshing = ref(false);
const paying = ref(false);
const polling = ref(false);
const error = ref('');
let timer: number | undefined;
let pollCount = 0;
let syncInFlight: Promise<Order> | undefined;

const orderId = computed(() => String(route.params.id || ''));
const directEntry = computed(() => route.query.entry === 'direct');
const historyRoute = computed(() => ({
  path: '/history',
  query: order.value?.parkingLotId
    ? { parkingLotId: order.value.parkingLotId, ...(directEntry.value ? { entry: 'direct' } : {}) }
    : {},
}));
const backRoute = computed(() => {
  if (route.query.from === 'history') {
    const returnId = typeof route.query.parkingLotId === 'string'
      ? route.query.parkingLotId
      : '';
    if (!returnId) return '/history';
    return `/history?parkingLotId=${encodeURIComponent(returnId)}${directEntry.value ? '&entry=direct' : ''}`;
  }
  return order.value?.parkingLotId
    ? directEntry.value
      ? `/pay?parkingLotId=${encodeURIComponent(order.value.parkingLotId)}`
      : `/pay/${encodeURIComponent(order.value.parkingLotId)}`
    : '/pay';
});
watch(order, (value) => {
  document.title = value?.parkingLotName
    ? `${value.parkingLotName} - 缴费结果`
    : '缴费结果';
});
const resultIcon = computed(() => {
  if (order.value?.status === 'paid') return 'checked';
  if (order.value?.status === 'pending') return 'clock-o';
  if (order.value?.status === 'refunded') return 'replay';
  return 'close';
});
const resultTitle = computed(() => {
  if (order.value?.status === 'paid') return '缴费成功';
  if (order.value?.status === 'pending') return '等待支付确认';
  if (order.value?.status === 'refunded') return '款项已退款';
  return '订单已关闭';
});
const resultDescription = computed(() => {
  if (order.value?.status === 'paid') return '停车费已到账，请妥善保存缴费凭证';
  if (order.value?.status === 'pending') return '支付结果可能有短暂延迟，请勿重复创建订单';
  if (order.value?.status === 'refunded') return '退款到账时间以微信支付通知为准';
  return '此订单未完成支付，如有需要请重新填写';
});

function stopPolling() {
  if (timer !== undefined) window.clearTimeout(timer);
  timer = undefined;
  polling.value = false;
}

function syncCurrentOrder() {
  syncInFlight ??= publicApi
    .syncOrder(orderId.value)
    .finally(() => {
      syncInFlight = undefined;
    });
  return syncInFlight;
}

async function pollOnce() {
  timer = undefined;
  if (!polling.value || order.value?.status !== 'pending') return;
  pollCount += 1;
  try {
    order.value = await syncCurrentOrder();
    if (order.value.status !== 'pending') {
      stopPolling();
      if (order.value.status === 'paid') showSuccessToast('支付已确认');
      return;
    }
  } catch {
    // 短暂网络失败不中断后续查单。
  }
  if (pollCount >= 20) {
    stopPolling();
    return;
  }
  if (polling.value) timer = window.setTimeout(() => void pollOnce(), 3000);
}

function startPolling() {
  stopPolling();
  if (order.value?.status !== 'pending') return;
  polling.value = true;
  timer = window.setTimeout(() => void pollOnce(), 3000);
}

async function refresh(manual = false) {
  if (!orderId.value || refreshing.value) return;
  error.value = '';
  if (manual) refreshing.value = true;
  else loading.value = true;
  try {
    order.value = manual
      ? await syncCurrentOrder()
      : await publicApi.order(orderId.value);
    if (order.value.status === 'pending') {
      pollCount = 0;
      startPolling();
      if (manual) showToast('已更新订单状态');
    } else {
      stopPolling();
    }
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '查询失败，请稍后重试';
    if (manual) showFailToast(error.value);
  } finally {
    loading.value = false;
    refreshing.value = false;
  }
}

async function continuePay() {
  if (!order.value?.paymentParams || paying.value) return;
  paying.value = true;
  try {
    const session = await publicApi.session();
    if (session.paymentMode === 'mock') {
      showLoadingToast({ message: '正在模拟支付…', duration: 0, forbidClick: true });
      order.value = await publicApi.mockPay(order.value.id);
      closeToast();
      showSuccessToast('支付成功');
      stopPolling();
      return;
    }
    const result = await invokeWechatPay(order.value.paymentParams);
    if (result === 'cancel') showToast('已取消支付');
    await refresh(true);
  } catch (reason) {
    closeToast();
    showFailToast(reason instanceof Error ? reason.message : '支付未完成');
  } finally {
    paying.value = false;
  }
}

async function copyOrderNo() {
  if (!order.value) return;
  try {
    await navigator.clipboard.writeText(order.value.orderNo);
    showSuccessToast('订单号已复制');
  } catch {
    showToast('请长按订单号复制');
  }
}

onMounted(() => void refresh());
onBeforeUnmount(stopPolling);
</script>

<style scoped>
.result-page :deep(.van-nav-bar) {
  border-bottom: 1px solid var(--line);
}

.result-page :deep(.van-nav-bar__arrow) {
  color: var(--ink);
  font-size: 20px;
}

.result-shell {
  display: grid;
  gap: 12px;
  padding: 14px;
}

.result-status {
  padding: 25px 18px 22px;
  text-align: center;
}

.status-icon {
  display: grid;
  width: 62px;
  height: 62px;
  margin: 0 auto 12px;
  place-items: center;
  border-radius: 50%;
  color: #fff;
  background: var(--brand);
  box-shadow: 0 9px 22px rgba(0, 113, 220, 0.22);
  font-size: 34px;
}

.is-paid .status-icon {
  background: var(--success);
  box-shadow: 0 9px 22px rgba(11, 127, 25, 0.22);
}

.is-pending .status-icon {
  color: #6d4d00;
  background: var(--accent-soft);
  box-shadow: none;
}

.is-closed .status-icon {
  color: #62666b;
  background: #eceeef;
  box-shadow: none;
}

.is-refunded .status-icon {
  color: var(--brand-dark);
  background: var(--brand-soft);
  box-shadow: none;
}

.result-status h1 {
  margin: 0;
  font-size: 22px;
}

.result-status > p {
  margin: 8px 0 16px;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.5;
}

.result-amount {
  color: var(--ink);
  font-size: 36px;
  font-weight: 750;
  letter-spacing: -0.02em;
}

.result-amount small {
  margin-right: 3px;
  font-size: 18px;
}

.checking-row {
  display: inline-flex;
  min-height: 29px;
  align-items: center;
  gap: 6px;
  margin-top: 15px;
  padding: 5px 10px;
  border-radius: 999px;
  color: #6d4d00;
  background: var(--accent-soft);
  font-size: 11px;
}

.cancel-notice {
  border-radius: 12px;
}

.receipt-card {
  padding: 0 16px;
}

.receipt-head {
  display: flex;
  min-height: 66px;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px dashed #dddddd;
}

.receipt-head > div > span,
.receipt-head small {
  display: block;
}

.receipt-head > div > span {
  font-size: 16px;
  font-weight: 700;
}

.receipt-head small {
  margin-top: 3px;
  color: var(--muted);
  font-size: 11px;
}

.receipt-list {
  margin: 0;
  padding: 8px 0;
}

.receipt-list > div {
  display: grid;
  grid-template-columns: 82px minmax(0, 1fr);
  gap: 12px;
  min-height: 43px;
  align-items: center;
  padding: 6px 0;
}

.receipt-list dt {
  color: var(--muted);
  font-size: 13px;
}

.receipt-list dd {
  min-width: 0;
  margin: 0;
  color: #3f4145;
  font-size: 13px;
  line-height: 1.45;
  text-align: right;
  overflow-wrap: anywhere;
}

.receipt-list .plate-text {
  font-size: 17px;
  font-weight: 750;
  letter-spacing: 0.08em;
}

.order-number {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 5px;
}

.order-number span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.order-number button {
  display: grid;
  flex: 0 0 34px;
  height: 34px;
  padding: 0;
  place-items: center;
  border: 0;
  color: var(--brand);
  background: transparent;
  font-size: 17px;
}

.receipt-foot {
  padding: 13px 0 16px;
  border-top: 1px dashed #dddddd;
  color: var(--muted);
  font-size: 11px;
  text-align: center;
}

.receipt-foot .van-icon {
  margin-right: 4px;
  color: var(--brand);
}

.result-actions {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
  gap: 10px;
  padding-top: 2px;
}

.result-loading,
.result-error {
  display: flex;
  min-height: 300px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 30px;
  text-align: center;
}

.result-loading {
  gap: 14px;
  color: var(--muted);
  font-size: 13px;
}

.result-error h1 {
  margin: 12px 0 5px;
  font-size: 20px;
}

.result-error p {
  margin: 0 0 18px;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.5;
}
</style>
