<template>
  <main class="app-page payment-page">
    <header class="pay-hero">
      <div class="hero-mark" aria-hidden="true">P</div>
      <div>
        <p class="hero-eyebrow">便捷停车服务</p>
        <h1>停车费缴纳</h1>
        <div v-if="parkingLot" class="hero-lot-row">
          <p class="hero-lot-name">{{ parkingLot.name }}</p>
          <button v-if="canSwitchLot" type="button" class="switch-lot-button" @click="switchParkingLot">
            切换停车场 <van-icon name="arrow" />
          </button>
        </div>
        <p>信息确认无误后，通过微信安全支付</p>
      </div>
    </header>

    <div class="pay-content">
      <router-link class="surface-card history-entry" :to="historyRoute">
        <span class="history-entry-icon"><van-icon name="orders-o" /></span>
        <span class="history-entry-copy">
          <strong>我的缴费记录</strong>
          <small>查看已支付、已退款订单</small>
        </span>
        <van-icon name="arrow" class="history-entry-arrow" />
      </router-link>

      <van-notice-bar
        v-if="session?.oauthRequired"
        color="#6d4d00"
        background="#fff5cc"
        left-icon="info-o"
        text="尚未获取微信身份，请在微信内重新打开二维码"
        wrapable
      />

      <div v-if="loading" class="surface-card form-skeleton" aria-label="正在加载">
        <van-skeleton title :row="7" />
      </div>

      <div v-else-if="loadError" class="surface-card load-error">
        <van-icon name="warning-o" size="34" color="#9a6700" />
        <strong>暂时无法加载缴费信息</strong>
        <span>{{ loadError }}</span>
        <van-button plain round type="primary" class="touch-button" @click="loadInitial">
          重新加载
        </van-button>
      </div>

      <section v-else-if="!parkingLot" class="surface-card lot-selector">
        <h2>选择停车场</h2>
        <p>请选择本次缴费对应的停车场</p>
        <div class="lot-options">
          <button
            v-for="lot in parkingLots"
            :key="lot.id"
            type="button"
            class="lot-option"
            @click="router.replace({ path: '/pay', query: { parkingLotId: lot.id } })"
          >
            <span class="lot-option-icon"><van-icon name="location-o" /></span>
            <strong>{{ lot.name }}</strong>
            <van-icon name="arrow" />
          </button>
        </div>
      </section>

      <van-form v-else class="pay-form" validate-trigger="onBlur" @submit="submitOrder">
        <section class="surface-card form-section">
          <div class="section-head">
            <div>
              <h2 class="section-title">缴费身份</h2>
              <p class="section-subtitle">请选择当前车辆对应类型</p>
            </div>
            <span class="required-note">必填</span>
          </div>
          <div class="type-selector" role="radiogroup" aria-label="缴费身份">
            <button
              v-for="option in customerOptions"
              :key="option.value"
              type="button"
              class="type-option"
              :class="{ active: form.customerType === option.value }"
              role="radio"
              :aria-checked="form.customerType === option.value"
              @click="form.customerType = option.value"
            >
              <span class="type-icon" aria-hidden="true">
                <van-icon :name="option.icon" />
              </span>
              <span>
                <b>{{ option.label }}</b>
                <small>{{ option.description }}</small>
              </span>
              <van-icon v-if="form.customerType === option.value" name="success" class="selected-icon" />
            </button>
          </div>
        </section>

        <section class="surface-card form-section details-section">
          <div class="section-head compact">
            <div>
              <h2 class="section-title">车辆信息</h2>
              <p class="section-subtitle">用于核对缴费记录，请准确填写</p>
            </div>
            <button v-if="hasRecent" type="button" class="recent-button" @click="restoreRecent">
              <van-icon name="clock-o" /> 最近填写
            </button>
          </div>
          <van-cell-group :border="false" inset class="field-group">
            <van-field
              v-model.trim="form.address"
              name="address"
              label="地址"
              placeholder="例：幸福里 2 栋 301 室"
              maxlength="60"
              clearable
              autocomplete="street-address"
              :rules="[
                { required: true, message: '请填写地址' },
                { validator: validateAddress, message: '地址至少填写2个字符' },
              ]"
            />
            <div ref="plateFieldRef" class="plate-field-wrap">
              <PlateNumberInput
                v-model="form.plateNumber"
                v-model:new-energy="newEnergy"
                :default-prefix="parkingLot.platePrefix"
                :error="plateError"
              />
            </div>
          </van-cell-group>
        </section>

        <section class="surface-card form-section">
          <div class="section-head">
            <div>
              <h2 class="section-title">选择缴费时长</h2>
              <p class="section-subtitle">金额按当前身份自动计算</p>
            </div>
          </div>

          <div class="duration-grid" role="radiogroup" aria-label="缴费时长">
            <button
              v-for="months in durations"
              :key="months"
              type="button"
              class="duration-option"
              :class="{ active: form.durationMonths === months }"
              :disabled="priceFor(months) === undefined"
              role="radio"
              :aria-checked="form.durationMonths === months"
              @click="form.durationMonths = months"
            >
              <b>{{ durationText[months] }}</b>
              <span v-if="priceFor(months) !== undefined" class="amount-value">
                ¥{{ formatMoney(priceFor(months)) }}
              </span>
              <span v-else>暂不可选</span>
              <i v-if="form.durationMonths === months" aria-hidden="true">
                <van-icon name="success" />
              </i>
            </button>
          </div>

          <div class="fee-note">
            <van-icon name="shield-o" />
            <span>应付金额由系统价格表计算，订单提交后金额不会变动</span>
          </div>
        </section>

        <div class="pay-spacer" aria-hidden="true"></div>
        <footer class="pay-bar safe-bottom">
          <div class="pay-total">
            <span>合计</span>
            <strong v-if="currentAmount !== undefined" class="amount-value">
              <small>¥</small>{{ formatMoney(currentAmount) }}
            </strong>
            <strong v-else>—</strong>
          </div>
          <van-button
            round
            type="primary"
            native-type="submit"
            class="pay-button touch-button"
            :loading="submitting"
            loading-text="正在创建订单"
            :disabled="!prices?.enabled || currentAmount === undefined || session?.oauthRequired"
          >
            微信支付
          </van-button>
        </footer>
      </van-form>
    </div>
  </main>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { closeToast, showFailToast, showLoadingToast, showToast } from 'vant';
import { ApiError, publicApi } from '../api';
import PlateNumberInput from '../components/PlateNumberInput.vue';
import type {
  CustomerType,
  DurationMonths,
  ParkingLot,
  PriceConfig,
  PublicSession,
} from '../types';
import {
  durationText,
  formatMoney,
  invokeWechatPay,
  isValidPlate,
  normalizePlate,
} from '../utils';

const route = useRoute();
const router = useRouter();
const RECENT_KEY = 'park-fee:recent-payer';
const OAUTH_RETURN_HISTORY_KEY = 'park-fee:oauth-return-history';
const OAUTH_RETURN_HISTORY_ENTRY_KEY = 'park-fee:oauth-return-history-entry';
const OAUTH_RETURN_DIRECT_KEY = 'park-fee:oauth-return-direct';

const customerOptions: Array<{
  value: CustomerType;
  label: string;
  description: string;
  icon: string;
}> = [
  { value: 'merchant', label: '商户租户', description: '商铺、办公租户', icon: 'shop-o' },
  { value: 'resident', label: '居民', description: '小区常住居民', icon: 'wap-home-o' },
];
const durations: DurationMonths[] = [1, 3, 6, 12];

const form = reactive({
  customerType: 'resident' as CustomerType,
  address: '',
  plateNumber: '',
  durationMonths: 1 as DurationMonths,
});
const prices = ref<PriceConfig>();
const parkingLot = ref<ParkingLot>();
const parkingLots = ref<ParkingLot[]>([]);
const session = ref<PublicSession>();
const loading = ref(true);
const submitting = ref(false);
const loadError = ref('');
const recent = ref<Partial<typeof form> | null>(null);
const newEnergy = ref(false);
const plateError = ref('');
const plateFieldRef = ref<HTMLElement | null>(null);
let clientRequestId = '';
let requestFingerprint = '';
let loadSequence = 0;
let formParkingLotId = '';

const hasRecent = computed(() => Boolean(recent.value?.address || recent.value?.plateNumber));
const currentAmount = computed(() => priceFor(form.durationMonths));
const isQrLocked = computed(() => typeof route.params.parkingLotId === 'string');
const routeParkingLotId = computed(() => {
  if (typeof route.params.parkingLotId === 'string') return route.params.parkingLotId;
  return typeof route.query.parkingLotId === 'string' ? route.query.parkingLotId : '';
});
const canSwitchLot = computed(() => !isQrLocked.value && !!parkingLot.value && parkingLots.value.length > 1);
const historyRoute = computed(() => ({
  path: '/history',
  query: parkingLot.value
    ? { parkingLotId: parkingLot.value.id, ...(!isQrLocked.value ? { entry: 'direct' } : {}) }
    : {},
}));

function switchParkingLot() {
  void router.replace('/pay');
}

function resultQuery(extra: Record<string, string> = {}) {
  return { ...extra, ...(!isQrLocked.value ? { entry: 'direct' } : {}) };
}

function priceFor(months: DurationMonths) {
  return prices.value?.items.find(
    (item) => item.customerType === form.customerType && item.durationMonths === months,
  )?.amount;
}

function recentKey() {
  return parkingLot.value ? `${RECENT_KEY}:${parkingLot.value.id}` : RECENT_KEY;
}

function readRecent() {
  try {
    const value = localStorage.getItem(recentKey());
    recent.value = value ? JSON.parse(value) : null;
  } catch {
    recent.value = null;
  }
}

function restoreRecent() {
  if (!recent.value) return;
  if (recent.value.customerType === 'merchant' || recent.value.customerType === 'resident') {
    form.customerType = recent.value.customerType;
  }
  form.address = recent.value.address || '';
  form.plateNumber = recent.value.plateNumber || parkingLot.value?.platePrefix || '新A';
  newEnergy.value = Array.from(normalizePlate(form.plateNumber)).length === 8;
  if (durations.includes(recent.value.durationMonths as DurationMonths)) {
    form.durationMonths = recent.value.durationMonths as DurationMonths;
  }
  showToast('已填入最近信息');
}

function saveRecent() {
  const value = {
    customerType: form.customerType,
    address: form.address,
    plateNumber: normalizePlate(form.plateNumber),
    durationMonths: form.durationMonths,
  };
  try {
    localStorage.setItem(recentKey(), JSON.stringify(value));
    recent.value = value;
  } catch {
    // 隐私模式下 localStorage 可能不可用，不影响支付主流程。
  }
}

const validateAddress = (value: string) => value.trim().length >= 2;
watch(() => form.plateNumber, (value) => {
  if (isValidPlate(value) && Array.from(normalizePlate(value)).length === (newEnergy.value ? 8 : 7)) {
    plateError.value = '';
  }
});
watch(newEnergy, () => {
  plateError.value = '';
});

function createClientRequestId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function loadInitial() {
  const sequence = ++loadSequence;
  loading.value = true;
  loadError.value = '';
  prices.value = undefined;
  parkingLot.value = undefined;
  session.value = undefined;
  try {
    const searchParams = new URLSearchParams(window.location.search);
    const hashQuery = window.location.hash.includes('?')
      ? new URLSearchParams(window.location.hash.slice(window.location.hash.indexOf('?') + 1))
      : new URLSearchParams();
    const code = searchParams.get('code') || hashQuery.get('code') || undefined;
    const state = searchParams.get('state') || hashQuery.get('state') || undefined;
    if (isQrLocked.value) {
      try {
        sessionStorage.removeItem(OAUTH_RETURN_DIRECT_KEY);
      } catch {
        // 会话存储不可用时二维码路由本身仍保持锁定。
      }
    }
    // 微信回调可能落在站点根路径。先核验 state 并恢复二维码内的场地，再读取价格。
    let sessionResult: PublicSession | undefined;
    if (code || state) {
      sessionResult = await publicApi.session({ code, state, parkingLotId: routeParkingLotId.value || undefined });
      if (sequence !== loadSequence) return;
      if (sessionResult.oauthRequired) throw new Error('微信身份验证未完成，请重新打开缴费页面');
      const cleanUrl = new URL(window.location.href);
      cleanUrl.searchParams.delete('code');
      cleanUrl.searchParams.delete('state');
      if (cleanUrl.hash.includes('?')) {
        const [hashPath, hashSearch] = cleanUrl.hash.slice(1).split('?', 2);
        const params = new URLSearchParams(hashSearch);
        params.delete('code');
        params.delete('state');
        cleanUrl.hash = `#${hashPath}${params.size ? `?${params}` : ''}`;
      }
      window.history.replaceState(
        window.history.state,
        document.title,
        `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`,
      );
      const resumeId = sessionResult.resumeParkingLotId;
      let returnDirect = false;
      try {
        returnDirect = !!resumeId && sessionStorage.getItem(OAUTH_RETURN_DIRECT_KEY) === resumeId;
        sessionStorage.removeItem(OAUTH_RETURN_DIRECT_KEY);
      } catch {
        // 来源标记仅影响是否展示换场入口；停车场 ID 始终来自服务端已校验的 state。
      }
      if (resumeId) {
        try {
          sessionStorage.removeItem(OAUTH_RETURN_HISTORY_KEY);
          sessionStorage.removeItem(OAUTH_RETURN_HISTORY_ENTRY_KEY);
        } catch {
          // 会话存储不可用时仍可通过 OAuth state 恢复停车场。
        }
        if (routeParkingLotId.value !== resumeId || (!isQrLocked.value) !== returnDirect) {
          await router.replace(returnDirect
            ? { path: '/pay', query: { parkingLotId: resumeId } }
            : `/pay/${encodeURIComponent(resumeId)}`);
          return;
        }
      } else {
        try {
          const historyReturn = sessionStorage.getItem(OAUTH_RETURN_HISTORY_KEY);
          const historyEntry = sessionStorage.getItem(OAUTH_RETURN_HISTORY_ENTRY_KEY);
          if (historyReturn) {
            sessionStorage.removeItem(OAUTH_RETURN_HISTORY_KEY);
            sessionStorage.removeItem(OAUTH_RETURN_HISTORY_ENTRY_KEY);
            await router.replace({
              path: '/history',
              query: historyReturn === '1' ? {} : {
                parkingLotId: historyReturn,
                ...(historyEntry === 'direct' ? { entry: 'direct' } : {}),
              },
            });
            return;
          }
        } catch {
          // 会话存储不可用时停留在缴费页，不影响正常缴费。
        }
      }
      if (!resumeId && routeParkingLotId.value) {
        // 回调没有已核验的场地时，不沿用地址栏中可能被篡改的 ID。
        await router.replace('/pay');
        return;
      }
    }

    const lots = await publicApi.parkingLots();
    if (sequence !== loadSequence) return;
    parkingLots.value = lots;
    const requestedId = routeParkingLotId.value;
    if (!requestedId) {
      if (lots.length === 1) {
        await router.replace({ path: '/pay', query: { parkingLotId: lots[0].id } });
        return;
      }
      if (lots.length === 0) loadError.value = '当前没有开放缴费的停车场';
      return;
    }

    const lot = lots.find((item) => item.id === requestedId);
    if (!lot) {
      loadError.value = isQrLocked.value
        ? '该停车场不存在或已停用，请重新扫描有效二维码'
        : '该停车场不存在或已停用，请重新选择停车场';
      return;
    }
    parkingLot.value = lot;
    if (formParkingLotId !== lot.id || !form.plateNumber) {
      // 只在首次进入或换场时填入该场默认前缀，不覆盖同场已填写的完整车牌。
      form.plateNumber = lot.platePrefix;
      formParkingLotId = lot.id;
      newEnergy.value = false;
    }
    document.title = `${lot.name} - 停车缴费`;
    readRecent();

    if (!sessionResult) {
      sessionResult = await publicApi.session({ parkingLotId: lot.id });
      if (sequence !== loadSequence) return;
    }
    session.value = sessionResult;
    if (sessionResult.oauthRequired) {
      if (!sessionResult.authorizationUrl) {
        throw new Error('请在微信内重新打开该停车场的缴费二维码');
      }
      try {
        sessionStorage.removeItem(OAUTH_RETURN_HISTORY_KEY);
        sessionStorage.removeItem(OAUTH_RETURN_HISTORY_ENTRY_KEY);
        if (isQrLocked.value) sessionStorage.removeItem(OAUTH_RETURN_DIRECT_KEY);
        else sessionStorage.setItem(OAUTH_RETURN_DIRECT_KEY, lot.id);
      } catch {
        // 会话存储不可用时，OAuth state 仍保存停车场 ID。
      }
      window.location.replace(sessionResult.authorizationUrl);
      return;
    }

    const priceResult = await publicApi.prices(lot.id);
    if (sequence !== loadSequence) return;
    prices.value = priceResult;
    if (!priceResult.enabled) loadError.value = '当前缴费通道暂未开放';
    if (priceFor(form.durationMonths) === undefined) {
      const available = durations.find((months) => priceFor(months) !== undefined);
      if (available) form.durationMonths = available;
    }
  } catch (error) {
    if (sequence === loadSequence) {
      loadError.value = error instanceof Error ? error.message : '加载失败，请稍后重试';
    }
  } finally {
    if (sequence === loadSequence) loading.value = false;
  }
}

async function submitOrder() {
  if (submitting.value) return;
  form.plateNumber = normalizePlate(form.plateNumber);
  if (!isValidPlate(form.plateNumber) || Array.from(form.plateNumber).length !== (newEnergy.value ? 8 : 7)) {
    plateError.value = newEnergy.value ? '请输入正确的 8 位新能源车牌号' : '请输入正确的 7 位普通车牌号';
    await nextTick();
    plateFieldRef.value?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    showFailToast(plateError.value);
    return;
  }
  if (!parkingLot.value || !session.value || currentAmount.value === undefined) {
    showFailToast('缴费信息尚未准备好');
    return;
  }
  if (session.value.oauthRequired) {
    showFailToast('请在微信中重新打开二维码');
    return;
  }

  submitting.value = true;
  showLoadingToast({ message: '正在创建订单…', duration: 0, forbidClick: true });
  try {
    const priceVersion = Number(prices.value?.version);
    const fingerprint = JSON.stringify({
      parkingLotId: parkingLot.value.id,
      priceVersion,
      expectedAmount: currentAmount.value,
      customerType: form.customerType,
      address: form.address.trim(),
      plateNumber: form.plateNumber,
      durationMonths: form.durationMonths,
    });
    if (!clientRequestId || requestFingerprint !== fingerprint) {
      clientRequestId = createClientRequestId();
      requestFingerprint = fingerprint;
    }
    const order = await publicApi.createOrder({
      parkingLotId: parkingLot.value.id,
      clientRequestId,
      priceVersion,
      expectedAmount: currentAmount.value,
      customerType: form.customerType,
      address: form.address.trim(),
      plateNumber: form.plateNumber,
      durationMonths: form.durationMonths,
    });
    clientRequestId = '';
    requestFingerprint = '';
    saveRecent();

    if (order.status !== 'pending') {
      closeToast();
      await router.replace({ path: `/result/${order.id}`, query: resultQuery() });
      return;
    }

    if (session.value.paymentMode === 'mock') {
      showLoadingToast({ message: '正在模拟支付…', duration: 0, forbidClick: true });
      await publicApi.mockPay(order.id);
      closeToast();
      await router.replace({ path: `/result/${order.id}`, query: resultQuery({ paid: '1' }) });
      return;
    }

    closeToast();
    if (!order.paymentParams) {
      await router.replace({ path: `/result/${order.id}`, query: resultQuery() });
      return;
    }
    try {
      const result = await invokeWechatPay(order.paymentParams);
      await router.replace({
        path: `/result/${order.id}`,
        query: resultQuery(result === 'cancel' ? { payment: 'cancel' } : { paid: '1' }),
      });
    } catch {
      // JSAPI 返回失败时结果仍可能延迟到达，统一进结果页查单。
      await router.replace({ path: `/result/${order.id}`, query: resultQuery({ payment: 'error' }) });
    }
  } catch (error) {
    closeToast();
    if (error instanceof ApiError && error.code === 'PRICE_CHANGED') {
      clientRequestId = '';
      requestFingerprint = '';
      await loadInitial();
    }
    showFailToast({
      message: error instanceof Error ? error.message : '订单提交失败，请重试',
      wordBreak: 'break-word',
    });
  } finally {
    submitting.value = false;
  }
}

onMounted(() => {
  void loadInitial();
});
watch([() => route.params.parkingLotId, () => route.query.parkingLotId], () => {
  // 场地变更时不能沿用上一停车场填写的车辆信息或下单幂等请求号。
  form.customerType = 'resident';
  form.address = '';
  form.plateNumber = '';
  formParkingLotId = '';
  form.durationMonths = 1;
  newEnergy.value = false;
  plateError.value = '';
  recent.value = null;
  clientRequestId = '';
  requestFingerprint = '';
  void loadInitial();
});
</script>

<style scoped>
.payment-page {
  padding-bottom: env(safe-area-inset-bottom);
}

.pay-hero {
  position: relative;
  display: flex;
  align-items: center;
  min-height: 170px;
  padding: max(26px, env(safe-area-inset-top)) 22px 35px;
  overflow: hidden;
  color: #fff;
  background:
    radial-gradient(circle at 88% 8%, rgba(255, 255, 255, 0.19) 0 62px, transparent 63px),
    radial-gradient(circle at 74% 88%, rgba(255, 255, 255, 0.1) 0 88px, transparent 89px),
    linear-gradient(140deg, var(--brand-dark) 0%, var(--brand) 100%);
}

.hero-mark {
  display: grid;
  flex: 0 0 58px;
  height: 58px;
  margin-right: 16px;
  place-items: center;
  border: 1px solid rgba(255, 194, 32, 0.58);
  border-radius: 18px;
  color: var(--accent);
  background: rgba(0, 62, 119, 0.3);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.28);
  font-size: 32px;
  font-weight: 800;
}

.hero-eyebrow {
  margin: 0 0 5px !important;
  color: rgba(255, 255, 255, 0.74) !important;
  font-size: 12px !important;
  font-weight: 600;
  letter-spacing: 0.16em;
}

.pay-hero h1 {
  margin: 0;
  font-size: 26px;
  line-height: 1.25;
  letter-spacing: 0.02em;
}

.pay-hero p {
  margin: 7px 0 0;
  color: rgba(255, 255, 255, 0.83);
  font-size: 13px;
}

.pay-hero .hero-lot-name {
  color: #fff;
  font-size: 15px;
  font-weight: 700;
}

.hero-lot-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px 10px;
}

.hero-lot-row .hero-lot-name {
  min-width: 0;
  overflow-wrap: anywhere;
}

.switch-lot-button {
  min-height: 30px;
  margin-top: 7px;
  padding: 4px 9px;
  border: 1px solid rgba(255, 255, 255, 0.68);
  border-radius: 999px;
  color: #fff;
  background: rgba(0, 56, 112, 0.28);
  font-size: 11px;
  white-space: nowrap;
}

.pay-content {
  position: relative;
  z-index: 1;
  margin-top: -18px;
  padding: 0 14px;
}

.history-entry {
  display: flex;
  min-height: 59px;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
  padding: 9px 14px;
  color: var(--ink);
  text-decoration: none;
}

.history-entry-icon {
  display: grid;
  flex: 0 0 36px;
  height: 36px;
  place-items: center;
  border-radius: 11px;
  color: var(--brand);
  background: var(--brand-soft);
  font-size: 20px;
}

.history-entry-copy {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 2px;
}

.history-entry-copy strong {
  font-size: 14px;
}

.history-entry-copy small {
  color: var(--muted);
  font-size: 11px;
}

.history-entry-arrow {
  color: #8d9398;
}

.pay-content > .van-notice-bar {
  margin-bottom: 12px;
  border-radius: 12px;
}

.pay-form {
  display: grid;
  gap: 12px;
}

.lot-selector {
  padding: 20px 16px;
}

.lot-selector h2 {
  margin: 0;
  font-size: 19px;
}

.lot-selector > p {
  margin: 7px 0 17px;
  color: var(--muted);
  font-size: 13px;
}

.lot-options {
  display: grid;
  gap: 10px;
}

.lot-option {
  display: flex;
  width: 100%;
  min-height: 66px;
  align-items: center;
  gap: 11px;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 13px;
  color: var(--ink);
  background: #fafafa;
  text-align: left;
}

.lot-option:active {
  border-color: var(--brand);
  background: var(--brand-soft);
}

.lot-option strong {
  min-width: 0;
  flex: 1;
  font-size: 14px;
  overflow-wrap: anywhere;
}

.lot-option > .van-icon:last-child {
  color: var(--brand);
}

.lot-option-icon {
  display: grid;
  flex: 0 0 37px;
  height: 37px;
  place-items: center;
  border-radius: 10px;
  color: var(--brand);
  background: var(--brand-soft);
  font-size: 21px;
}

.form-section {
  padding: 18px 16px;
}

.section-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 15px;
}

.section-head.compact {
  margin-bottom: 10px;
}

.required-note {
  padding-top: 2px;
  color: #6d4d00;
  font-size: 12px;
}

.type-selector {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.type-option {
  position: relative;
  display: flex;
  min-width: 0;
  min-height: 70px;
  align-items: center;
  padding: 11px;
  border: 1px solid var(--line);
  border-radius: 14px;
  color: var(--ink);
  text-align: left;
  background: #fafafa;
  transition: 0.16s ease;
}

.type-option.active {
  border-color: var(--brand);
  background: var(--brand-soft);
  box-shadow: 0 0 0 1px rgba(0, 113, 220, 0.09);
}

.type-icon {
  display: grid;
  flex: 0 0 32px;
  height: 32px;
  margin-right: 8px;
  place-items: center;
  border-radius: 10px;
  color: var(--brand);
  background: #fff;
  font-size: 19px;
}

.type-option b,
.type-option small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.type-option b {
  font-size: 14px;
}

.type-option small {
  margin-top: 4px;
  color: var(--muted);
  font-size: 11px;
}

.selected-icon {
  position: absolute;
  top: 5px;
  right: 5px;
  display: grid;
  width: 18px;
  height: 18px;
  place-items: center;
  border-radius: 50%;
  color: #4a3600;
  background: var(--accent);
  font-size: 12px;
}

.recent-button {
  display: inline-flex;
  min-height: 36px;
  align-items: center;
  gap: 4px;
  padding: 0 9px;
  border: 0;
  border-radius: 999px;
  color: var(--brand);
  background: var(--brand-soft);
  font-size: 12px;
  white-space: nowrap;
}

.details-section {
  padding-right: 0;
  padding-bottom: 6px;
  padding-left: 0;
}

.details-section .section-head {
  padding: 0 16px;
}

.field-group {
  margin: 0;
}

.field-group :deep(.van-field) {
  min-height: 58px;
  align-items: center;
  padding-right: 16px;
  padding-left: 16px;
}

.field-group :deep(.van-field__label) {
  width: 4.3em;
  font-weight: 600;
}

.plate-field-wrap {
  padding: 0 16px 12px;
}

.duration-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.duration-option {
  position: relative;
  min-height: 68px;
  padding: 11px 10px;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 13px;
  color: var(--ink);
  background: #fafafa;
}

.duration-option.active {
  border-color: var(--brand);
  color: var(--brand-dark);
  background: var(--brand-soft);
}

.duration-option:disabled {
  color: #94989d;
  background: #f5f5f5;
}

.duration-option b,
.duration-option span {
  display: block;
}

.duration-option b {
  margin-bottom: 5px;
  font-size: 15px;
}

.duration-option span {
  color: var(--muted);
  font-size: 12px;
}

.duration-option.active span {
  color: var(--brand);
}

.duration-option i {
  position: absolute;
  right: -1px;
  bottom: -2px;
  display: grid;
  width: 27px;
  height: 25px;
  place-items: center;
  border-radius: 13px 0 0;
  color: #4a3600;
  background: var(--accent);
  font-size: 13px;
  font-style: normal;
}

.fee-note {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  margin-top: 14px;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.5;
}

.fee-note .van-icon {
  flex: 0 0 auto;
  margin-top: 2px;
  color: var(--brand);
}

.pay-spacer {
  height: 92px;
}

.pay-bar {
  position: fixed;
  z-index: 20;
  right: 0;
  bottom: 0;
  left: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  width: 100%;
  max-width: 560px;
  min-height: 76px;
  margin: 0 auto;
  padding: 10px 14px max(10px, env(safe-area-inset-bottom));
  border-top: 1px solid rgba(221, 221, 221, 0.86);
  background: rgba(255, 255, 255, 0.96);
  box-shadow: 0 -8px 24px rgba(0, 45, 86, 0.07);
  backdrop-filter: blur(14px);
}

.pay-total span,
.pay-total strong {
  display: block;
}

.pay-total span {
  margin-bottom: 2px;
  color: var(--muted);
  font-size: 11px;
}

.pay-total strong {
  color: var(--brand-dark);
  font-size: 23px;
  line-height: 1;
}

.pay-total small {
  margin-right: 2px;
  font-size: 13px;
}

.pay-button {
  --van-button-primary-background: var(--success);
  --van-button-primary-border-color: var(--success);
  flex: 0 0 min(48vw, 210px);
  height: 48px;
  border-color: var(--success);
  background: var(--success);
  box-shadow: 0 7px 18px rgba(11, 127, 25, 0.24);
}

.form-skeleton,
.load-error {
  min-height: 300px;
  padding: 28px 20px;
}

.load-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 11px;
  text-align: center;
}

.load-error strong {
  margin-top: 3px;
  font-size: 16px;
}

.load-error span {
  margin-bottom: 8px;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.5;
}

@media (max-width: 350px) {
  .pay-content {
    padding-right: 10px;
    padding-left: 10px;
  }

  .form-section {
    padding-right: 13px;
    padding-left: 13px;
  }

  .type-option {
    padding: 9px 7px;
  }

  .type-icon {
    flex-basis: 28px;
    height: 28px;
    margin-right: 6px;
  }
}
</style>
