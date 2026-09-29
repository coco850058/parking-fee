<template>
  <main class="app-page admin-page">
    <header class="admin-header">
      <div>
        <p>停车服务</p>
        <h1>管理后台</h1>
      </div>
      <div class="header-actions">
        <button type="button" aria-label="刷新数据" @click="refreshCurrent">
          <van-icon name="replay" />
        </button>
        <button type="button" aria-label="退出登录" @click="logout">
          <van-icon name="sign" />
        </button>
      </div>
    </header>

    <van-tabs
      v-model:active="activeTab"
      sticky
      animated
      swipeable
      shrink
      class="admin-tabs"
      offset-top="0"
      @change="handleTabChange"
    >
      <van-tab title="经营概览" name="summary">
        <section class="admin-content summary-content">
          <label class="lot-filter-card" for="summary-parking-lot">
            <span>停车场</span>
            <select id="summary-parking-lot" v-model="summaryParkingLotId" @change="loadSummary">
              <option value="">全部停车场</option>
              <option v-for="lot in parkingLots" :key="lot.id" :value="lot.id">{{ lot.name }}</option>
            </select>
          </label>
          <div class="summary-range" aria-label="经营概览统计周期">
            <button
              v-for="period in summaryPeriods"
              :key="period.value"
              type="button"
              :class="{ active: summaryPeriod === period.value }"
              :aria-pressed="summaryPeriod === period.value"
              @click="setSummaryPeriod(period.value)"
            >
              {{ period.label }}
            </button>
          </div>

          <div v-if="summaryPeriod === 'year'" class="summary-year">
            <label for="summary-year-select">选择年份</label>
            <select id="summary-year-select" v-model.number="summaryYear" @change="loadSummary">
              <option v-for="year in yearOptions" :key="year" :value="year">{{ year }} 年</option>
            </select>
          </div>

          <div v-if="summaryLoading" class="surface-card panel-loading">
            <van-skeleton title :row="5" />
          </div>

          <div v-else-if="summaryError && !summary" class="surface-card panel-error">
            <van-empty image="network" :description="summaryError">
              <van-button round type="primary" size="small" @click="loadSummary">重新加载</van-button>
            </van-empty>
          </div>

          <template v-else-if="summary">
            <section class="today-card">
              <div class="today-head">
                <span>{{ summaryPeriodLabel }}实收</span>
                <span>{{ summaryDateText }}</span>
              </div>
              <div class="today-amount amount-value"><small>¥</small>{{ formatMoney(summary.selected.amount) }}</div>
              <div class="today-count">共 {{ summary.selected.count }} 笔已支付订单</div>
            </section>

            <div class="summary-grid">
              <section class="surface-card metric-card">
                <span>本月实收</span>
                <strong class="amount-value">¥{{ formatMoney(summary.month.amount) }}</strong>
                <small>{{ summary.month.count }} 笔</small>
              </section>
              <section class="surface-card metric-card">
                <span>累计实收</span>
                <strong class="amount-value">¥{{ formatMoney(summary.all.amount) }}</strong>
                <small>{{ summary.all.count }} 笔</small>
              </section>
            </div>

            <button type="button" class="surface-card pending-card" @click="openPendingOrders">
              <span class="pending-icon"><van-icon name="clock-o" /></span>
              <span class="pending-copy">
                <b>待支付订单</b>
                <small>查看仍在等待支付的记录</small>
              </span>
              <strong>{{ summary.pendingCount }}</strong>
              <van-icon name="arrow" />
            </button>

            <section class="surface-card quick-actions">
              <div class="block-heading">
                <div>
                  <h2>快捷操作</h2>
                  <p>常用管理功能</p>
                </div>
              </div>
              <div class="action-grid">
                <button type="button" @click="activeTab = 'orders'">
                  <span><van-icon name="orders-o" /></span>
                  <b>缴费记录</b>
                </button>
                <button type="button" @click="activeTab = 'prices'">
                  <span><van-icon name="balance-list-o" /></span>
                  <b>缴费标准</b>
                </button>
                <button type="button" @click="activeTab = 'lots'">
                  <span><van-icon name="location-o" /></span>
                  <b>停车场</b>
                </button>
                <button type="button" :disabled="exporting" @click="exportOrders">
                  <span><van-icon name="down" /></span>
                  <b>{{ exporting ? '正在导出' : '导出记录' }}</b>
                </button>
              </div>
            </section>
          </template>
        </section>
      </van-tab>

      <van-tab title="缴费标准" name="prices">
        <section class="admin-content prices-content">
          <div class="page-intro">
            <div>
              <h2>缴费金额设置</h2>
              <p>金额单位为元，修改后仅影响新订单</p>
            </div>
            <span v-if="priceConfig">版本 {{ priceConfig.version }}</span>
          </div>

          <label class="lot-filter-card" for="price-parking-lot">
            <span>设置停车场</span>
            <select id="price-parking-lot" v-model="priceParkingLotId" @change="loadPrices">
              <option value="" disabled>请选择停车场</option>
              <option v-for="lot in parkingLots" :key="lot.id" :value="lot.id">
                {{ lot.name }}{{ lot.active ? '' : '（停用中）' }}
              </option>
            </select>
          </label>

          <van-empty v-if="!priceParkingLotId && !parkingLotsLoading" description="请先新增并选择停车场" />

          <div v-else-if="pricesLoading" class="surface-card panel-loading">
            <van-skeleton title :row="8" />
          </div>

          <div v-else-if="pricesError && !priceConfig" class="surface-card panel-error">
            <van-empty image="network" :description="pricesError">
              <van-button round type="primary" size="small" @click="loadPrices">重新加载</van-button>
            </van-empty>
          </div>

          <template v-else-if="priceConfig">
            <section
              v-for="customerType in customerTypes"
              :key="customerType"
              class="surface-card price-group"
            >
              <div class="price-group-head">
                <span class="price-group-icon">
                  <van-icon :name="customerType === 'merchant' ? 'shop-o' : 'wap-home-o'" />
                </span>
                <div>
                  <h3>{{ customerTypeText[customerType] }}</h3>
                  <p>{{ customerType === 'merchant' ? '商铺及办公租户' : '小区常住居民' }}</p>
                </div>
              </div>

              <div class="price-matrix">
                <label v-for="months in durations" :key="months" class="price-input-card">
                  <span>{{ durationText[months] }}</span>
                  <div>
                    <i>¥</i>
                    <input
                      v-model="priceInputs[priceKey(customerType, months)]"
                      type="text"
                      inputmode="decimal"
                      maxlength="10"
                      :aria-label="`${customerTypeText[customerType]}${durationText[months]}金额`"
                      @blur="normalizePriceInput(customerType, months)"
                    />
                  </div>
                </label>
              </div>
            </section>

            <div class="price-save-bar safe-bottom">
              <van-button
                round
                block
                type="primary"
                class="touch-button"
                :loading="savingPrices"
                loading-text="正在保存"
                @click="savePrices"
              >
                保存缴费标准
              </van-button>
            </div>
          </template>
        </section>
      </van-tab>

      <van-tab title="缴费记录" name="orders">
        <section class="admin-content orders-content">
          <section class="surface-card filter-card">
            <label class="lot-filter-card records-lot-filter" for="orders-parking-lot">
              <span>停车场</span>
              <select id="orders-parking-lot" v-model="filters.parkingLotId" @change="applyFilters">
                <option value="">全部停车场</option>
                <option v-for="lot in parkingLots" :key="lot.id" :value="lot.id">{{ lot.name }}</option>
              </select>
            </label>
            <van-search
              v-model="filters.keyword"
              shape="round"
              placeholder="搜索车牌、地址或订单号"
              maxlength="50"
              clearable
              @search="applyFilters"
              @clear="applyFilters"
            />

            <div class="quick-range" aria-label="快捷日期筛选">
              <button
                v-for="range in dateRanges"
                :key="range.value"
                type="button"
                :class="{ active: activeRange === range.value }"
                @click="setDateRange(range.value)"
              >
                {{ range.label }}
              </button>
              <button
                type="button"
                :class="{ active: activeRange === 'custom' }"
                @click="openCustomDateRange"
              >
                自选日期
              </button>
            </div>
            <p v-if="activeRange === 'custom'" class="custom-range-summary">
              创建时间：{{ filters.from }} 至 {{ filters.to }}
            </p>

            <van-dropdown-menu active-color="#0071dc" swipe-threshold="3">
              <van-dropdown-item
                v-model="filters.status"
                :options="statusOptions"
                teleport="body"
                @change="applyFilters"
              />
              <van-dropdown-item
                v-model="filters.customerType"
                :options="customerOptions"
                teleport="body"
                @change="applyFilters"
              />
              <van-dropdown-item
                v-model="filters.durationMonths"
                :options="durationOptions"
                teleport="body"
                @change="applyFilters"
              />
            </van-dropdown-menu>
          </section>

          <div class="orders-toolbar">
            <span>共 {{ orderTotal }} 条记录</span>
            <button type="button" :disabled="exporting" @click="exportOrders">
              <van-icon name="down" /> {{ exporting ? '正在导出' : '导出 CSV' }}
            </button>
          </div>

          <div v-if="ordersLoading && orders.length === 0" class="orders-loading-list">
            <div v-for="index in 3" :key="index" class="surface-card order-skeleton">
              <van-skeleton title :row="3" />
            </div>
          </div>

          <div v-else-if="ordersError && orders.length === 0" class="surface-card panel-error">
            <van-empty image="network" :description="ordersError">
              <van-button round type="primary" size="small" @click="loadOrders(true)">重新加载</van-button>
            </van-empty>
          </div>

          <van-empty
            v-else-if="orders.length === 0"
            class="surface-card orders-empty"
            image="search"
            description="没有符合条件的缴费记录"
          />

          <div v-else class="order-list">
            <button
              v-for="item in orders"
              :key="item.id"
              type="button"
              class="surface-card order-card"
              @click="openOrder(item)"
            >
              <div class="order-card-head">
                <div>
                  <strong>{{ item.plateNumber }}</strong>
                  <span>{{ customerTypeText[item.customerType] }}</span>
                </div>
                <span :class="['status-pill', displayStatusTone(item)]">
                  {{ displayStatusText(item) }}
                </span>
              </div>
              <div class="order-card-body">
                <p><van-icon name="shop-o" /> {{ item.parkingLotName || '未知停车场' }}</p>
                <p><van-icon name="location-o" /> {{ item.address }}</p>
                <p><van-icon name="clock-o" /> {{ durationText[item.durationMonths] }} · {{ formatDateTime(item.createdAt) }}</p>
              </div>
              <div class="order-card-foot">
                <span class="order-no">{{ item.orderNo }}</span>
                <strong class="amount-value">¥{{ formatMoney(item.amount) }}</strong>
              </div>
            </button>

            <van-button
              v-if="orders.length < orderTotal"
              plain
              round
              block
              type="primary"
              class="load-more touch-button"
              :loading="ordersLoading"
              @click="loadOrders(false)"
            >
              加载更多
            </van-button>
            <p v-else class="list-end">已显示全部记录</p>
          </div>
        </section>
      </van-tab>

      <van-tab title="停车场" name="lots">
        <section class="admin-content lots-content">
          <div class="page-intro">
            <div>
              <h2>停车场管理</h2>
              <p>各停车场独立定价，启用后可导出专属缴费二维码</p>
            </div>
          </div>
          <van-button round block type="primary" class="touch-button" @click="openLotEditor()">
            <van-icon name="plus" /> 新增停车场
          </van-button>
          <div v-if="parkingLotsLoading" class="surface-card panel-loading"><van-skeleton title :row="4" /></div>
          <van-empty v-else-if="parkingLots.length === 0" class="surface-card" description="暂无停车场" />
          <section v-for="lot in parkingLots" :key="lot.id" class="surface-card lot-card">
            <div class="lot-card-head">
              <div>
                <h3>{{ lot.name }}</h3>
                <small>{{ lot.active ? '已启用 · 可扫码缴费' : '已停用 · 无法新建订单' }}</small>
                <small>默认车牌前两位：{{ lot.platePrefix }}</small>
              </div>
              <span :class="['lot-state', lot.active ? 'active' : 'inactive']">{{ lot.active ? '启用' : '停用' }}</span>
            </div>
            <div class="lot-actions">
              <button type="button" @click="openLotEditor(lot)">编辑</button>
              <button type="button" @click="selectLotForPrices(lot)">设置价格</button>
              <button v-if="lot.active" type="button" @click="openLotQr(lot)">缴费二维码</button>
              <button type="button" :class="{ danger: lot.active }" @click="toggleLot(lot)">
                {{ lot.active ? '停用' : '启用' }}
              </button>
            </div>
          </section>
        </section>
      </van-tab>
    </van-tabs>

    <van-calendar
      v-model:show="calendarVisible"
      type="range"
      title="选择订单创建日期"
      switch-mode="year-month"
      :first-day-of-week="1"
      :allow-same-day="true"
      :min-date="calendarMinDate"
      :max-date="calendarMaxDate"
      :default-date="calendarInitialDates"
      :show-confirm="true"
      :show-range-prompt="true"
      teleport="body"
      confirm-text="确认查询"
      @confirm="confirmCustomDateRange"
    />

    <van-popup
      v-model:show="detailVisible"
      position="bottom"
      round
      closeable
      safe-area-inset-bottom
      class="order-detail-popup"
    >
      <div class="detail-sheet">
        <header>
          <span>订单详情</span>
          <small v-if="selectedOrder">{{ selectedOrder.orderNo }}</small>
        </header>

        <div v-if="detailLoading" class="detail-loading">
          <van-loading color="#0071dc" />
        </div>

        <template v-else-if="selectedOrder">
          <div class="detail-summary">
            <div>
              <span>{{ selectedOrder.plateNumber }}</span>
              <small>{{ customerTypeText[selectedOrder.customerType] }} · {{ durationText[selectedOrder.durationMonths] }}</small>
            </div>
            <div>
              <strong class="amount-value">¥{{ formatMoney(selectedOrder.amount) }}</strong>
              <span :class="['status-pill', displayStatusTone(selectedOrder)]">
                {{ displayStatusText(selectedOrder) }}
              </span>
            </div>
          </div>

          <dl class="detail-list">
            <div><dt>停车场</dt><dd>{{ selectedOrder.parkingLotName || '未知停车场' }}</dd></div>
            <div><dt>地址</dt><dd>{{ selectedOrder.address }}</dd></div>
            <div><dt>创建时间</dt><dd>{{ formatDateTime(selectedOrder.createdAt) }}</dd></div>
            <div v-if="selectedOrder.paidAt"><dt>支付时间</dt><dd>{{ formatDateTime(selectedOrder.paidAt) }}</dd></div>
            <div><dt>订单号</dt><dd>{{ selectedOrder.orderNo }}</dd></div>
            <div v-if="selectedOrder.transactionId"><dt>微信支付单号</dt><dd>{{ selectedOrder.transactionId }}</dd></div>
            <div><dt>价格版本</dt><dd>{{ selectedOrder.priceVersion }}</dd></div>
          </dl>

          <section v-if="selectedOrder.refund" class="refund-panel">
            <div class="refund-panel-head">
              <h3>退款状态</h3>
              <span :class="['status-pill', refundStatusTone(selectedOrder.refund.status)]">
                {{ refundStatusText[selectedOrder.refund.status] }}
              </span>
            </div>
            <p>{{ refundStatusHint[selectedOrder.refund.status] }}</p>
            <dl class="refund-detail-list">
              <div><dt>退款金额</dt><dd>¥{{ formatMoney(selectedOrder.refund.amount) }}</dd></div>
              <div><dt>申请时间</dt><dd>{{ formatDateTime(selectedOrder.refund.requestedAt) }}</dd></div>
              <div v-if="selectedOrder.refund.successAt">
                <dt>成功时间</dt><dd>{{ formatDateTime(selectedOrder.refund.successAt) }}</dd>
              </div>
            </dl>
            <van-button
              v-if="selectedOrder.refund.status !== 'success'"
              plain
              round
              block
              type="primary"
              class="touch-button refund-sync-button"
              :loading="refundBusy"
              loading-text="正在核对"
              @click="syncSelectedRefund"
            >
              刷新退款状态
            </van-button>
          </section>

          <div v-if="isRefundUncertain" class="refund-uncertain">
            上次退款请求结果尚未确认，请先刷新订单详情，勿重复发起。
            <van-button size="small" plain type="primary" :loading="detailLoading" @click="refreshSelectedOrder">
              刷新订单详情
            </van-button>
          </div>

          <van-button
            v-if="canSubmitRefund"
            round
            block
            plain
            type="danger"
            class="touch-button refund-action-button"
            :loading="refundBusy"
            loading-text="正在提交退款"
            :disabled="detailLoading"
            @click="startFullRefund"
          >
            {{ canRetryRefund ? '重试提交退款' : '整单全额退款' }} · ¥{{ formatMoney(selectedOrder.amount) }}
          </van-button>

          <van-button plain round block type="primary" class="touch-button" @click="copySelectedOrderNo">
            复制订单号
          </van-button>
        </template>
      </div>
    </van-popup>

    <van-popup
      v-model:show="lotEditorVisible"
      position="bottom"
      round
      closeable
      safe-area-inset-bottom
      class="lot-popup"
    >
      <div class="lot-sheet">
        <h2>{{ editingLotId ? '编辑停车场' : '新增停车场' }}</h2>
        <label for="parking-lot-name">停车场名称</label>
        <input id="parking-lot-name" v-model="lotNameInput" maxlength="80" placeholder="请输入停车场名称" />
        <label id="parking-lot-prefix-label" class="lot-prefix-label">默认车牌前两位</label>
        <div class="lot-prefix-selects" role="group" aria-labelledby="parking-lot-prefix-label">
          <select v-model="lotProvinceInput" aria-label="省份简称">
            <option v-for="province in plateProvinces" :key="province" :value="province">{{ province }}</option>
          </select>
          <select v-model="lotLetterInput" aria-label="发牌机关字母">
            <option v-for="letter in plateLetters" :key="letter" :value="letter">{{ letter }}</option>
          </select>
        </div>
        <p>缴费页会预填这两位，车主仍可自行修改。{{ editingLotId ? '' : '新停车场默认停用，设置价格后再启用。' }}</p>
        <van-button round block type="primary" class="touch-button" :loading="savingLot" @click="saveLot">
          保存
        </van-button>
      </div>
    </van-popup>

    <van-popup
      v-model:show="lotQrVisible"
      position="bottom"
      round
      closeable
      safe-area-inset-bottom
      class="lot-popup"
    >
      <div class="lot-sheet qr-sheet">
        <h2>{{ qrLot?.name }}缴费二维码</h2>
        <p>微信扫码后将直接进入该停车场，缴费时不可切换停车场。</p>
        <div class="qr-preview">
          <van-loading v-if="qrLoading" color="#0071dc" />
          <img v-else-if="qrDataUrl" :src="qrDataUrl" :alt="`${qrLot?.name}缴费二维码`" />
        </div>
        <p class="qr-save-hint">微信内若无法直接下载，可长按二维码图片保存。</p>
        <p class="qr-link">{{ qrLot?.paymentUrl }}</p>
        <div class="qr-actions">
          <van-button round plain type="primary" class="touch-button" :disabled="!qrDataUrl" @click="downloadLotQr">下载 PNG</van-button>
          <van-button round type="primary" class="touch-button" @click="copyLotUrl">复制链接</van-button>
        </div>
      </div>
    </van-popup>
  </main>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import {
  showConfirmDialog,
  showFailToast,
  showSuccessToast,
  showToast,
} from 'vant';
import { adminApi, isUnauthorized } from '../api';
import type {
  AdminParkingLot,
  AdminSummary,
  CustomerType,
  DurationMonths,
  Order,
  OrderFilters,
  OrderStatus,
  PriceConfig,
  PriceItem,
  RefundStatus,
  SummaryPeriod,
} from '../types';
import {
  customerTypeText,
  durationText,
  formatDateTime,
  formatMoney,
  localDate,
  plateLetters,
  plateProvinces,
  statusText,
  statusTone,
} from '../utils';

type DateRangeValue = 'today' | 'week' | 'month' | 'year' | 'all' | 'custom';

function beijingTodayIso() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((part) => part.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function calendarDate(isoDate: string) {
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function shiftIsoDate(isoDate: string, days: number) {
  const [year, month, day] = isoDate.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
}

const router = useRouter();
const activeTab = ref('summary');
const parkingLots = ref<AdminParkingLot[]>([]);
const parkingLotsLoading = ref(false);
const summaryParkingLotId = ref('');
const priceParkingLotId = ref('');
const lotEditorVisible = ref(false);
const editingLotId = ref('');
const lotNameInput = ref('');
const lotProvinceInput = ref('新');
const lotLetterInput = ref('A');
const savingLot = ref(false);
const lotQrVisible = ref(false);
const qrLot = ref<AdminParkingLot>();
const qrDataUrl = ref('');
const qrLoading = ref(false);
const summary = ref<AdminSummary>();
const summaryLoading = ref(false);
const summaryError = ref('');
const summaryPeriod = ref<SummaryPeriod>('today');
const todayIso = ref(beijingTodayIso());
const summaryYear = ref(Number(todayIso.value.slice(0, 4)));
const availableYears = ref<number[]>([summaryYear.value]);
const priceConfig = ref<PriceConfig>();
const pricesLoading = ref(false);
const pricesError = ref('');
const savingPrices = ref(false);
const priceInputs = reactive<Record<string, string>>({});
const orders = ref<Order[]>([]);
const orderTotal = ref(0);
const orderPage = ref(1);
const ordersLoading = ref(false);
const ordersError = ref('');
const exporting = ref(false);
const activeRange = ref<DateRangeValue>('month');
const calendarVisible = ref(false);
const calendarInitialDates = ref<Date[]>([]);
const calendarMinDate = new Date(1970, 0, 1);
const calendarMaxDate = computed(() => calendarDate(todayIso.value));
const detailVisible = ref(false);
const detailLoading = ref(false);
const selectedOrder = ref<Order>();
const refundBusy = ref(false);
const refundUncertainIds = ref<Set<string>>(new Set());
let ordersRequestId = 0;
let summaryRequestId = 0;

const customerTypes: CustomerType[] = ['merchant', 'resident'];
const durations: DurationMonths[] = [1, 3, 6, 12];
const filters = reactive<{
  keyword: string;
  status: OrderStatus | '';
  customerType: CustomerType | '';
  durationMonths: DurationMonths | '';
  parkingLotId: string;
  from: string;
  to: string;
}>({
  keyword: '',
  status: '',
  customerType: '',
  durationMonths: '',
  parkingLotId: '',
  from: '',
  to: '',
});

const dateRanges: Array<{ value: DateRangeValue; label: string }> = [
  { value: 'today', label: '今天' },
  { value: 'week', label: '近7天' },
  { value: 'month', label: '本月' },
  { value: 'year', label: '今年' },
  { value: 'all', label: '全部' },
];
const summaryPeriods: Array<{ value: SummaryPeriod; label: string }> = [
  { value: 'today', label: '今日' },
  { value: 'week', label: '本周' },
  { value: 'month', label: '本月' },
  { value: 'year', label: '今年' },
];
const statusOptions = [
  { text: '全部状态', value: '' },
  { text: '已支付', value: 'paid' },
  { text: '待支付', value: 'pending' },
  { text: '已关闭', value: 'closed' },
  { text: '已退款', value: 'refunded' },
];
const customerOptions = [
  { text: '全部身份', value: '' },
  { text: '商户租户', value: 'merchant' },
  { text: '居民', value: 'resident' },
];
const durationOptions = [
  { text: '全部时长', value: '' },
  { text: '1个月', value: 1 },
  { text: '3个月', value: 3 },
  { text: '半年', value: 6 },
  { text: '一年', value: 12 },
];

const refundStatusText: Record<RefundStatus, string> = {
  requesting: '退款请求中',
  processing: '退款处理中',
  success: '退款成功',
  closed: '退款已关闭',
  abnormal: '退款异常',
};
const refundStatusHint: Record<RefundStatus, string> = {
  requesting: '退款申请已记录。若长时间未更新，请先刷新状态；必要时可使用原退款单号重试。',
  processing: '微信正在处理退款，最终结果以微信确认状态为准。',
  success: '微信已确认退款成功，此订单已标记为已退款。',
  closed: '退款已关闭，不会自动重试；请到微信支付商户平台人工核查。',
  abnormal: '退款状态异常，不会自动重试；请到微信支付商户平台人工核查。',
};

const isRefundUncertain = computed(() =>
  selectedOrder.value ? refundUncertainIds.value.has(String(selectedOrder.value.id)) : false,
);
const canRetryRefund = computed(() =>
  selectedOrder.value?.status === 'paid' &&
  selectedOrder.value.refund?.status === 'requesting' &&
  !isRefundUncertain.value,
);
const canSubmitRefund = computed(() =>
  selectedOrder.value?.status === 'paid' &&
  (!selectedOrder.value.refund || canRetryRefund.value) &&
  !isRefundUncertain.value,
);

function displayStatusText(order: Order) {
  if (order.status === 'paid' && order.refund) {
    if (order.refund.status === 'requesting' || order.refund.status === 'processing') {
      return '退款处理中';
    }
    if (order.refund.status === 'closed' || order.refund.status === 'abnormal') {
      return '退款未完成';
    }
  }
  return statusText[order.status];
}

function displayStatusTone(order: Order) {
  if (order.status === 'paid' && order.refund) {
    if (order.refund.status === 'requesting' || order.refund.status === 'processing') {
      return 'warning';
    }
    if (order.refund.status === 'closed' || order.refund.status === 'abnormal') {
      return 'muted';
    }
  }
  return statusTone[order.status];
}

function refundStatusTone(status: RefundStatus) {
  if (status === 'success') return 'info';
  if (status === 'requesting' || status === 'processing') return 'warning';
  return 'muted';
}

const summaryPeriodLabel = computed(() => {
  if (summaryPeriod.value === 'year' && summaryYear.value !== Number(todayIso.value.slice(0, 4))) return '全年';
  return summaryPeriods.find((item) => item.value === summaryPeriod.value)?.label || '今日';
});
const yearOptions = computed(() =>
  [...new Set([...availableYears.value, summaryYear.value, Number(todayIso.value.slice(0, 4))])]
    .filter((year) => Number.isInteger(year) && year >= 1970)
    .sort((a, b) => b - a),
);
const summaryDateText = computed(() => {
  if (summaryPeriod.value === 'year') return `${summaryYear.value} 年`;
  if (summaryPeriod.value === 'month') {
    return `${Number(todayIso.value.slice(0, 4))} 年 ${Number(todayIso.value.slice(5, 7))} 月`;
  }
  if (summaryPeriod.value === 'week') {
    const current = calendarDate(todayIso.value);
    const daysSinceMonday = (current.getDay() + 6) % 7;
    return `${shiftIsoDate(todayIso.value, -daysSinceMonday)} 至 ${todayIso.value}`;
  }
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  }).format(new Date());
});
const effectiveFilters = computed<Omit<OrderFilters, 'page' | 'pageSize'>>(() => ({
  keyword: filters.keyword.trim(),
  status: filters.status,
  customerType: filters.customerType,
  durationMonths: filters.durationMonths,
  parkingLotId: filters.parkingLotId,
  from: filters.from,
  to: filters.to,
}));
const appliedFilters = ref<Omit<OrderFilters, 'page' | 'pageSize'>>({ ...effectiveFilters.value });

async function exportOrders() {
  if (exporting.value) return;
  exporting.value = true;
  try {
    const csv = await adminApi.exportOrders(appliedFilters.value);
    const url = URL.createObjectURL(csv);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'parking-orders.csv';
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  } catch (error) {
    showFailToast(handleApiError(error, '导出失败，请缩小筛选范围后重试'));
  } finally {
    exporting.value = false;
  }
}

function handleApiError(error: unknown, fallback: string) {
  if (isUnauthorized(error)) {
    void router.replace('/admin/login');
    return '登录已失效，请重新登录';
  }
  return error instanceof Error ? error.message : fallback;
}

async function loadSummary() {
  const requestId = ++summaryRequestId;
  todayIso.value = beijingTodayIso();
  summaryLoading.value = true;
  summaryError.value = '';
  summary.value = undefined;
  try {
    const result = await adminApi.summary({
      period: summaryPeriod.value,
      ...(summaryPeriod.value === 'year' ? { year: summaryYear.value } : {}),
      parkingLotId: summaryParkingLotId.value,
    });
    if (requestId !== summaryRequestId) return;
    summary.value = result;
    availableYears.value = result.availableYears;
  } catch (error) {
    if (requestId !== summaryRequestId) return;
    summaryError.value = handleApiError(error, '汇总数据加载失败');
  } finally {
    if (requestId === summaryRequestId) summaryLoading.value = false;
  }
}

function setSummaryPeriod(period: SummaryPeriod) {
  if (summaryPeriod.value === period) return;
  if (period === 'year') summaryYear.value = Number(beijingTodayIso().slice(0, 4));
  summaryPeriod.value = period;
  void loadSummary();
}

function priceKey(customerType: CustomerType, months: DurationMonths) {
  return `${customerType}-${months}`;
}

function fillPriceInputs(config: PriceConfig) {
  customerTypes.forEach((customerType) => {
    durations.forEach((months) => {
      const amount = config.items.find(
        (item) => item.customerType === customerType && item.durationMonths === months,
      )?.amount;
      priceInputs[priceKey(customerType, months)] =
        amount === undefined ? '' : (amount / 100).toFixed(2);
    });
  });
}

async function loadPrices() {
  const parkingLotId = priceParkingLotId.value;
  priceConfig.value = undefined;
  if (!parkingLotId) return;
  pricesLoading.value = true;
  pricesError.value = '';
  try {
    const config = await adminApi.prices(parkingLotId);
    if (parkingLotId !== priceParkingLotId.value) return;
    priceConfig.value = config;
    fillPriceInputs(config);
  } catch (error) {
    if (parkingLotId === priceParkingLotId.value) pricesError.value = handleApiError(error, '缴费标准加载失败');
  } finally {
    if (parkingLotId === priceParkingLotId.value) pricesLoading.value = false;
  }
}

function normalizePriceInput(customerType: CustomerType, months: DurationMonths) {
  const key = priceKey(customerType, months);
  const value = Number(priceInputs[key]);
  if (Number.isFinite(value) && value >= 0) priceInputs[key] = value.toFixed(2);
}

async function savePrices() {
  const parkingLotId = priceParkingLotId.value;
  if (savingPrices.value || !parkingLotId) return;
  const items: PriceItem[] = [];
  for (const customerType of customerTypes) {
    for (const durationMonths of durations) {
      const raw = priceInputs[priceKey(customerType, durationMonths)].trim();
      if (!/^\d+(\.\d{1,2})?$/.test(raw) || Number(raw) <= 0) {
        showFailToast(`${customerTypeText[customerType]}${durationText[durationMonths]}金额无效`);
        return;
      }
      const amount = Math.round(Number(raw) * 100);
      if (!Number.isSafeInteger(amount)) {
        showFailToast('金额超出允许范围');
        return;
      }
      items.push({ customerType, durationMonths, amount });
    }
  }

  savingPrices.value = true;
  try {
    const config = await adminApi.savePrices(parkingLotId, items);
    if (parkingLotId === priceParkingLotId.value) {
      priceConfig.value = config;
      fillPriceInputs(config);
    }
    showSuccessToast('缴费标准已保存');
  } catch (error) {
    showFailToast(handleApiError(error, '保存失败，请重试'));
  } finally {
    savingPrices.value = false;
  }
}

function setDateRange(range: DateRangeValue, shouldLoad = true) {
  if (range === 'custom') return;
  activeRange.value = range;
  const today = beijingTodayIso();
  todayIso.value = today;
  filters.to = range === 'all' ? '' : today;
  if (range === 'today') filters.from = today;
  if (range === 'week') {
    filters.from = shiftIsoDate(today, -6);
  }
  if (range === 'month') filters.from = `${today.slice(0, 7)}-01`;
  if (range === 'year') filters.from = `${today.slice(0, 4)}-01-01`;
  if (range === 'all') filters.from = '';
  if (shouldLoad) void loadOrders(true);
}

function openCustomDateRange() {
  todayIso.value = beijingTodayIso();
  const from = filters.from || `${todayIso.value.slice(0, 7)}-01`;
  const to = filters.to || todayIso.value;
  calendarInitialDates.value = [calendarDate(from), calendarDate(to)];
  calendarVisible.value = true;
}

function confirmCustomDateRange(value: Date | Date[]) {
  if (!Array.isArray(value) || value.length !== 2) {
    showFailToast('请选择开始和结束日期');
    return;
  }
  const from = localDate(value[0]);
  const to = localDate(value[1]);
  if (from > to || to > beijingTodayIso() || from < '1970-01-01') {
    showFailToast('请选择有效的日期范围，结束日期不能晚于今天');
    return;
  }
  filters.from = from;
  filters.to = to;
  activeRange.value = 'custom';
  calendarVisible.value = false;
  void loadOrders(true);
}

function applyFilters() {
  void loadOrders(true);
}

async function loadOrders(reset: boolean) {
  const requestId = ++ordersRequestId;
  const requestedPage = reset ? 1 : orderPage.value;
  const queryFilters = reset ? { ...effectiveFilters.value } : { ...appliedFilters.value };
  if (reset) {
    appliedFilters.value = queryFilters;
    orderPage.value = 1;
    ordersError.value = '';
    orders.value = [];
    orderTotal.value = 0;
  }
  ordersLoading.value = true;
  try {
    const result = await adminApi.orders({
      ...queryFilters,
      page: requestedPage,
      pageSize: 20,
    });
    if (requestId !== ordersRequestId) return;
    orders.value = reset ? result.items : [...orders.value, ...result.items];
    orderTotal.value = result.total;
    orderPage.value = result.page + 1;
  } catch (error) {
    if (requestId !== ordersRequestId) return;
    ordersError.value = handleApiError(error, '缴费记录加载失败');
    if (!reset) showFailToast(ordersError.value);
  } finally {
    if (requestId === ordersRequestId) ordersLoading.value = false;
  }
}

function openPendingOrders() {
  filters.status = 'pending';
  filters.parkingLotId = summaryParkingLotId.value;
  activeRange.value = 'all';
  filters.from = '';
  filters.to = '';
  activeTab.value = 'orders';
  void loadOrders(true);
}

async function openOrder(item: Order) {
  selectedOrder.value = item;
  detailVisible.value = true;
  detailLoading.value = true;
  try {
    selectedOrder.value = await adminApi.order(item.id);
    refundUncertainIds.value.delete(String(item.id));
  } catch (error) {
    selectedOrder.value = undefined;
    detailVisible.value = false;
    showFailToast(handleApiError(error, '订单详情加载失败'));
  } finally {
    detailLoading.value = false;
  }
}

function applyOrderUpdate(order: Order) {
  if (selectedOrder.value && String(selectedOrder.value.id) === String(order.id)) {
    selectedOrder.value = order;
  }
  const index = orders.value.findIndex((item) => String(item.id) === String(order.id));
  if (index >= 0) orders.value[index] = order;
}

async function refreshSelectedOrder() {
  const id = selectedOrder.value?.id;
  if (!id || detailLoading.value) return;
  detailLoading.value = true;
  try {
    applyOrderUpdate(await adminApi.order(id));
    refundUncertainIds.value.delete(String(id));
    showSuccessToast('订单详情已更新');
  } catch (error) {
    showFailToast(handleApiError(error, '订单详情刷新失败'));
  } finally {
    detailLoading.value = false;
  }
}

async function startFullRefund() {
  const target = selectedOrder.value;
  if (!target || !canSubmitRefund.value || refundBusy.value) return;
  const isRetry = target.refund?.status === 'requesting';
  try {
    await showConfirmDialog({
      title: isRetry ? '确认重试退款提交？' : '确认整单全额退款？',
      message: `订单号：${target.orderNo}\n退款金额：¥${formatMoney(target.amount)}\n整单全额退款，提交后不可撤销。${isRetry ? '\n将使用原退款单号重试，不会创建第二笔退款。' : ''}`,
      confirmButtonText: isRetry ? '确认重试' : '确认全额退款',
      confirmButtonColor: '#c62828',
    });
  } catch {
    return;
  }
  if (String(selectedOrder.value?.id) !== String(target.id) || !canSubmitRefund.value) return;

  refundBusy.value = true;
  try {
    const updated = await adminApi.refundOrder(target.id);
    applyOrderUpdate(updated);
    showSuccessToast(updated.status === 'refunded' ? '退款已成功' : '退款申请已提交，请稍后刷新状态');
    void loadOrders(true);
    void loadSummary();
  } catch (error) {
    // 网络失败时退款可能已被服务端受理，先查单再决定是否允许再次操作。
    try {
      const latest = await adminApi.order(target.id);
      applyOrderUpdate(latest);
      if (latest.refund) {
        showToast('已查询到退款申请，请核对当前状态');
      } else {
        showFailToast(handleApiError(error, '退款提交失败，请稍后重试'));
      }
    } catch {
      refundUncertainIds.value.add(String(target.id));
      showFailToast('退款结果暂无法确认，请刷新订单详情后再操作');
    }
  } finally {
    refundBusy.value = false;
  }
}

async function syncSelectedRefund() {
  const target = selectedOrder.value;
  if (!target?.refund || refundBusy.value || target.refund.status === 'success') return;
  refundBusy.value = true;
  try {
    const updated = await adminApi.syncRefund(target.id);
    applyOrderUpdate(updated);
    showToast(updated.status === 'refunded' ? '微信已确认退款成功' : '已更新退款状态');
    void loadOrders(true);
    void loadSummary();
  } catch (error) {
    showFailToast(handleApiError(error, '退款状态查询失败'));
  } finally {
    refundBusy.value = false;
  }
}

async function copySelectedOrderNo() {
  if (!selectedOrder.value) return;
  try {
    await navigator.clipboard.writeText(selectedOrder.value.orderNo);
    showSuccessToast('订单号已复制');
  } catch {
    showToast('请长按订单号复制');
  }
}

async function logout() {
  try {
    await showConfirmDialog({
      title: '退出管理后台？',
      message: '退出后需重新输入管理密码。',
      confirmButtonText: '退出',
      confirmButtonColor: '#c62828',
    });
    await adminApi.logout();
    await router.replace('/admin/login');
  } catch {
    // 用户取消退出时无需提示。
  }
}

function refreshCurrent() {
  if (activeTab.value === 'summary') void loadSummary();
  if (activeTab.value === 'prices') void loadPrices();
  if (activeTab.value === 'orders') void loadOrders(true);
  if (activeTab.value === 'lots') void loadParkingLots();
}

function handleTabChange(name: string | number) {
  if (name === 'summary' && !summary.value) void loadSummary();
  if (name === 'prices' && !priceConfig.value) void loadPrices();
  if (name === 'orders' && orders.value.length === 0) void loadOrders(true);
  if (name === 'lots' && parkingLots.value.length === 0) void loadParkingLots();
}

async function loadParkingLots() {
  parkingLotsLoading.value = true;
  try {
    const lots = await adminApi.parkingLots();
    parkingLots.value = lots;
    if (!lots.some((lot) => lot.id === priceParkingLotId.value)) {
      priceParkingLotId.value = lots.find((lot) => lot.active)?.id || lots[0]?.id || '';
    }
    if (summaryParkingLotId.value && !lots.some((lot) => lot.id === summaryParkingLotId.value)) {
      summaryParkingLotId.value = '';
    }
    if (filters.parkingLotId && !lots.some((lot) => lot.id === filters.parkingLotId)) {
      filters.parkingLotId = '';
    }
  } catch (error) {
    showFailToast(handleApiError(error, '停车场加载失败'));
  } finally {
    parkingLotsLoading.value = false;
  }
}

function openLotEditor(lot?: AdminParkingLot) {
  editingLotId.value = lot?.id || '';
  lotNameInput.value = lot?.name || '';
  lotProvinceInput.value = lot?.platePrefix?.[0] || '新';
  lotLetterInput.value = lot?.platePrefix?.[1] || 'A';
  lotEditorVisible.value = true;
}

async function saveLot() {
  const name = lotNameInput.value.trim();
  const platePrefix = `${lotProvinceInput.value}${lotLetterInput.value}`;
  if (name.length < 2 || name.length > 80) {
    showFailToast('请输入 2 至 80 字的停车场名称');
    return;
  }
  if (!plateProvinces.includes(lotProvinceInput.value) || !plateLetters.includes(lotLetterInput.value)) {
    showFailToast('请选择有效的默认车牌前两位');
    return;
  }
  if (savingLot.value) return;
  savingLot.value = true;
  try {
    const lot = editingLotId.value
      ? await adminApi.updateParkingLot(editingLotId.value, { name, platePrefix })
      : await adminApi.createParkingLot(name, platePrefix);
    lotEditorVisible.value = false;
    await loadParkingLots();
    if (!editingLotId.value) priceParkingLotId.value = lot.id;
    showSuccessToast(editingLotId.value ? '停车场设置已更新' : '停车场已创建，请设置价格后启用');
  } catch (error) {
    showFailToast(handleApiError(error, '保存停车场失败'));
  } finally {
    savingLot.value = false;
  }
}

async function toggleLot(lot: AdminParkingLot) {
  try {
    await showConfirmDialog({
      title: lot.active ? '确认停用停车场？' : '确认启用停车场？',
      message: lot.active
        ? `停用“${lot.name}”后，其二维码无法新建缴费订单；历史订单仍可查询。`
        : `启用“${lot.name}”后，其缴费二维码即可使用。请先确认价格已设置。`,
      confirmButtonText: lot.active ? '确认停用' : '确认启用',
      confirmButtonColor: lot.active ? '#c62828' : '#0071dc',
    });
  } catch {
    return;
  }
  try {
    await adminApi.updateParkingLot(lot.id, { active: !lot.active });
    await loadParkingLots();
    void loadSummary();
    showSuccessToast(lot.active ? '停车场已停用' : '停车场已启用');
  } catch (error) {
    showFailToast(handleApiError(error, '操作失败'));
  }
}

function selectLotForPrices(lot: AdminParkingLot) {
  priceParkingLotId.value = lot.id;
  activeTab.value = 'prices';
  void loadPrices();
}

async function openLotQr(lot: AdminParkingLot) {
  qrLot.value = lot;
  qrDataUrl.value = '';
  lotQrVisible.value = true;
  qrLoading.value = true;
  try {
    const QRCode = await import('qrcode');
    qrDataUrl.value = await QRCode.toDataURL(lot.paymentUrl, {
      errorCorrectionLevel: 'H',
      margin: 2,
      width: 400,
      color: { dark: '#003d76', light: '#ffffff' },
    });
  } catch {
    showFailToast('二维码生成失败，请稍后重试');
  } finally {
    qrLoading.value = false;
  }
}

function downloadLotQr() {
  if (!qrLot.value || !qrDataUrl.value) return;
  const link = document.createElement('a');
  link.href = qrDataUrl.value;
  link.download = `停车缴费二维码-${qrLot.value.name.replace(/[\\/:*?"<>|]/g, '-')}.png`;
  document.body.append(link);
  link.click();
  link.remove();
}

async function copyLotUrl() {
  if (!qrLot.value) return;
  try {
    await navigator.clipboard.writeText(qrLot.value.paymentUrl);
    showSuccessToast('缴费链接已复制');
  } catch {
    showFailToast('复制失败，请长按链接复制');
  }
}

watch([activeTab, summaryParkingLotId, priceParkingLotId, () => filters.parkingLotId, parkingLots], () => {
  const selectedId = activeTab.value === 'summary' ? summaryParkingLotId.value
    : activeTab.value === 'prices' ? priceParkingLotId.value
      : activeTab.value === 'orders' ? filters.parkingLotId : '';
  const lot = parkingLots.value.find((item) => item.id === selectedId);
  document.title = lot ? `${lot.name} - 管理后台` : '管理后台 - 停车缴费';
}, { immediate: true });

onMounted(async () => {
  setDateRange('month', false);
  try {
    const auth = await adminApi.me();
    if (!auth.authenticated) {
      await router.replace('/admin/login');
      return;
    }
    await loadParkingLots();
    await Promise.all([loadSummary(), loadPrices(), loadOrders(true)]);
  } catch (error) {
    handleApiError(error, '后台加载失败');
  }
});
</script>

<style scoped>
.admin-page {
  padding-bottom: max(18px, env(safe-area-inset-bottom));
}

.admin-header {
  display: flex;
  min-height: 91px;
  align-items: center;
  justify-content: space-between;
  padding: max(19px, env(safe-area-inset-top)) 17px 14px;
  color: #fff;
  background:
    radial-gradient(circle at 85% -20%, rgba(255, 255, 255, 0.14) 0 82px, transparent 83px),
    linear-gradient(135deg, var(--brand-dark), var(--brand));
}

.admin-header p,
.admin-header h1 {
  margin: 0;
}

.admin-header p {
  margin-bottom: 2px;
  color: rgba(255, 255, 255, 0.68);
  font-size: 11px;
  letter-spacing: 0.14em;
}

.admin-header h1 {
  font-size: 21px;
}

.header-actions {
  display: flex;
  gap: 8px;
}

.header-actions button {
  display: grid;
  width: 44px;
  height: 44px;
  padding: 0;
  place-items: center;
  border: 1px solid rgba(255, 255, 255, 0.23);
  border-radius: 14px;
  color: #fff;
  background: rgba(255, 255, 255, 0.1);
  font-size: 20px;
}

.admin-tabs :deep(.van-tabs__wrap) {
  height: 49px;
  border-bottom: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.96);
  backdrop-filter: blur(12px);
}

.admin-tabs :deep(.van-tabs__nav) {
  width: 100%;
  justify-content: space-around;
}

.admin-tabs :deep(.van-tab) {
  flex: 1;
  min-height: 44px;
  font-weight: 600;
}

.admin-tabs :deep(.van-tabs__line) {
  width: 24px;
  height: 3px;
  border-radius: 3px;
}

.admin-content {
  padding: 14px;
}

.summary-content,
.prices-content,
.orders-content,
.lots-content,
.order-list,
.orders-loading-list {
  display: grid;
  gap: 12px;
}

.summary-range {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 7px;
}

.lot-filter-card {
  display: flex;
  min-width: 0;
  min-height: 48px;
  align-items: center;
  gap: 10px;
  padding: 7px 12px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: #fff;
}

.lot-filter-card > span {
  flex: 0 0 auto;
  color: var(--muted);
  font-size: 12px;
}

.lot-filter-card select {
  width: 100%;
  min-width: 0;
  min-height: 34px;
  padding: 0 8px;
  border: 0;
  outline-color: var(--brand);
  color: var(--ink);
  background: #fff;
  font: inherit;
  font-size: 13px;
  font-weight: 650;
  text-align: right;
}

.records-lot-filter {
  margin: 5px 0;
  background: #f6f7f8;
}

.records-lot-filter select {
  background: transparent;
}

.summary-range button {
  min-width: 0;
  min-height: 39px;
  padding: 0 3px;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: #55595e;
  background: #fff;
  font-size: 12px;
}

.summary-range button.active {
  border-color: var(--brand);
  color: var(--brand);
  background: var(--brand-soft);
  font-weight: 650;
}

.summary-year {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 11px 14px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: #fff;
  font-size: 13px;
}

.summary-year select {
  min-height: 34px;
  padding: 0 9px;
  border: 1px solid var(--line);
  border-radius: 8px;
  color: var(--brand-dark);
  background: #f6f7f8;
  font: inherit;
  font-weight: 650;
}

.today-card {
  position: relative;
  padding: 20px;
  overflow: hidden;
  border-radius: 18px;
  color: #fff;
  background:
    radial-gradient(circle at 91% 90%, rgba(255, 255, 255, 0.16) 0 65px, transparent 66px),
    linear-gradient(140deg, var(--brand-dark), var(--brand));
  box-shadow: 0 10px 28px rgba(0, 113, 220, 0.19);
}

.today-head {
  display: flex;
  justify-content: space-between;
  color: rgba(255, 255, 255, 0.76);
  font-size: 12px;
}

.today-amount {
  margin-top: 17px;
  font-size: 35px;
  font-weight: 750;
}

.today-amount small {
  margin-right: 3px;
  font-size: 18px;
}

.today-count {
  margin-top: 7px;
  color: rgba(255, 255, 255, 0.78);
  font-size: 12px;
}

.summary-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.metric-card {
  min-width: 0;
  padding: 16px;
}

.metric-card span,
.metric-card strong,
.metric-card small {
  display: block;
}

.metric-card span {
  color: var(--muted);
  font-size: 12px;
}

.metric-card strong {
  margin: 9px 0 5px;
  overflow: hidden;
  font-size: clamp(17px, 5vw, 22px);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.metric-card small {
  color: #7b7f84;
  font-size: 11px;
}

.pending-card {
  display: grid;
  grid-template-columns: 42px minmax(0, 1fr) auto 18px;
  min-height: 74px;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 12px 14px;
  color: var(--ink);
  text-align: left;
}

.pending-icon {
  display: grid;
  width: 42px;
  height: 42px;
  place-items: center;
  border-radius: 13px;
  color: #6d4d00;
  background: var(--accent-soft);
  font-size: 21px;
}

.pending-copy b,
.pending-copy small {
  display: block;
}

.pending-copy b {
  font-size: 14px;
}

.pending-copy small {
  margin-top: 4px;
  overflow: hidden;
  color: var(--muted);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pending-card > strong {
  color: #6d4d00;
  font-size: 22px;
}

.pending-card > .van-icon:last-child {
  color: #94989d;
}

.quick-actions {
  padding: 17px 15px;
}

.block-heading h2,
.block-heading p {
  margin: 0;
}

.block-heading h2 {
  font-size: 16px;
}

.block-heading p {
  margin-top: 3px;
  color: var(--muted);
  font-size: 11px;
}

.action-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin-top: 15px;
}

.action-grid button,
.action-grid a {
  display: flex;
  min-width: 0;
  min-height: 78px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 8px 3px;
  border: 0;
  border-radius: 13px;
  color: var(--ink);
  text-decoration: none;
  background: #f4f7fa;
}

.action-grid span {
  color: var(--brand);
  font-size: 22px;
}

.action-grid b {
  overflow: hidden;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.page-intro {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 3px 2px 2px;
}

.page-intro h2,
.page-intro p {
  margin: 0;
}

.page-intro h2 {
  font-size: 19px;
}

.page-intro p {
  margin-top: 5px;
  color: var(--muted);
  font-size: 12px;
}

.page-intro > span {
  padding: 5px 8px;
  border-radius: 999px;
  color: var(--brand);
  background: var(--brand-soft);
  font-size: 10px;
  white-space: nowrap;
}

.lot-card {
  padding: 16px;
}

.lot-card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.lot-card-head h3 {
  margin: 0;
  font-size: 16px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}

.lot-card-head small {
  display: block;
  margin-top: 5px;
  color: var(--muted);
  font-size: 11px;
}

.lot-state {
  flex: 0 0 auto;
  padding: 5px 9px;
  border-radius: 999px;
  font-size: 11px;
}

.lot-state.active {
  color: #00642a;
  background: #e5f5e9;
}

.lot-state.inactive {
  color: #666;
  background: #eee;
}

.lot-actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin-top: 16px;
}

.lot-actions button {
  min-height: 40px;
  padding: 6px;
  border: 1px solid #c9ddec;
  border-radius: 10px;
  color: var(--brand-dark);
  background: #f7fbff;
  font-size: 12px;
  font-weight: 650;
}

.lot-actions button.danger {
  border-color: #f3cccc;
  color: #b52626;
  background: #fff8f8;
}

.lot-popup {
  max-height: 90vh;
  overflow-y: auto;
}

.lot-sheet {
  width: 100%;
  max-width: 560px;
  margin: 0 auto;
  padding: 23px 18px max(22px, env(safe-area-inset-bottom));
}

.lot-sheet h2 {
  margin: 0 0 18px;
  font-size: 19px;
}

.lot-sheet label {
  display: block;
  margin-bottom: 8px;
  font-size: 13px;
  font-weight: 650;
}

.lot-sheet input {
  width: 100%;
  min-height: 46px;
  padding: 9px 12px;
  border: 1px solid var(--line);
  border-radius: 11px;
  background: #f8f9fa;
  font: inherit;
}

.lot-prefix-label {
  margin-top: 18px;
}

.lot-prefix-selects {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.lot-prefix-selects select {
  width: 100%;
  min-height: 46px;
  padding: 9px 12px;
  border: 1px solid var(--line);
  border-radius: 11px;
  color: var(--text);
  background: #f8f9fa;
  font: inherit;
}

.lot-sheet p {
  margin: 12px 0 18px;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.55;
}

.qr-preview {
  display: grid;
  width: min(100%, 300px);
  min-height: 260px;
  margin: 0 auto;
  place-items: center;
  background: #fff;
}

.qr-preview img {
  display: block;
  width: 100%;
  height: auto;
}

.qr-sheet .qr-save-hint {
  margin: 8px 0 0;
  text-align: center;
}

.qr-sheet .qr-link {
  overflow-wrap: anywhere;
  text-align: center;
}

.qr-actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.price-group {
  padding: 16px;
}

.price-group-head {
  display: flex;
  align-items: center;
  margin-bottom: 14px;
}

.price-group-icon {
  display: grid;
  width: 40px;
  height: 40px;
  margin-right: 10px;
  place-items: center;
  border-radius: 12px;
  color: var(--brand);
  background: var(--brand-soft);
  font-size: 21px;
}

.price-group-head h3,
.price-group-head p {
  margin: 0;
}

.price-group-head h3 {
  font-size: 15px;
}

.price-group-head p {
  margin-top: 3px;
  color: var(--muted);
  font-size: 11px;
}

.price-matrix {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 9px;
}

.price-input-card {
  min-width: 0;
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: #fafafa;
}

.price-input-card > span {
  display: block;
  margin-bottom: 7px;
  color: var(--muted);
  font-size: 11px;
}

.price-input-card > div {
  display: flex;
  align-items: center;
}

.price-input-card i {
  margin-right: 3px;
  color: var(--brand);
  font-size: 13px;
  font-style: normal;
  font-weight: 700;
}

.price-input-card input {
  width: 100%;
  min-width: 0;
  height: 30px;
  padding: 0;
  border: 0;
  outline: 0;
  color: var(--ink);
  background: transparent;
  font-size: 18px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.price-input-card:focus-within {
  border-color: var(--brand);
  box-shadow: 0 0 0 2px rgba(0, 113, 220, 0.09);
}

.price-save-bar {
  position: sticky;
  z-index: 3;
  bottom: 0;
  padding: 10px 0 2px;
  background: linear-gradient(transparent, #f2f2f2 22%);
}

.price-save-bar .van-button {
  height: 48px;
  box-shadow: 0 7px 20px rgba(0, 113, 220, 0.18);
}

.filter-card {
  overflow: visible;
  padding: 5px 10px 1px;
}

.filter-card :deep(.van-search) {
  padding: 7px 0 9px;
  background: transparent;
}

.filter-card :deep(.van-search__content) {
  border: 1px solid var(--line);
  background: #f6f7f8;
}

.quick-range {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
  padding: 0 0 9px;
}

.quick-range button {
  min-height: 36px;
  padding: 0 3px;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: #55595e;
  background: #fff;
  font-size: 12px;
}

.quick-range button.active {
  border-color: var(--brand);
  color: var(--brand);
  background: var(--brand-soft);
  font-weight: 650;
}

.custom-range-summary {
  margin: 0 0 8px;
  color: var(--muted);
  font-size: 11px;
  text-align: center;
}

.filter-card :deep(.van-dropdown-menu__bar) {
  height: 45px;
  border-top: 1px solid #eceeef;
  box-shadow: none;
}

.filter-card :deep(.van-dropdown-menu__title) {
  max-width: 92px;
  padding: 0 13px 0 5px;
  font-size: 12px;
}

.orders-toolbar {
  display: flex;
  min-height: 32px;
  align-items: center;
  justify-content: space-between;
  padding: 0 2px;
  color: var(--muted);
  font-size: 12px;
}

.orders-toolbar button {
  display: inline-flex;
  min-height: 32px;
  align-items: center;
  gap: 4px;
  padding: 0;
  border: 0;
  color: var(--brand);
  background: transparent;
  font-weight: 600;
}

.order-card {
  width: 100%;
  padding: 15px;
  color: var(--ink);
  text-align: left;
}

.order-card-head,
.order-card-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.order-card-head > div {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
}

.order-card-head strong {
  font-size: 18px;
  letter-spacing: 0.06em;
}

.order-card-head > div span {
  padding: 3px 7px;
  border-radius: 999px;
  color: var(--brand);
  background: var(--brand-soft);
  font-size: 10px;
  white-space: nowrap;
}

.order-card-body {
  margin: 13px 0;
  padding: 9px 10px;
  border-radius: 10px;
  background: #f6f7f8;
}

.order-card-body p {
  margin: 0;
  overflow: hidden;
  color: #5e6267;
  font-size: 11px;
  line-height: 1.65;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.order-card-body .van-icon {
  width: 16px;
  color: #7b7f84;
}

.order-card-foot {
  min-width: 0;
}

.order-no {
  min-width: 0;
  overflow: hidden;
  color: #85898e;
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.order-card-foot strong {
  flex: 0 0 auto;
  color: var(--brand-dark);
  font-size: 18px;
}

.order-skeleton {
  padding: 19px 15px;
}

.load-more {
  margin-top: 2px;
}

.list-end {
  margin: 3px 0;
  color: #94989d;
  font-size: 11px;
  text-align: center;
}

.orders-empty {
  min-height: 280px;
}

.panel-loading {
  min-height: 260px;
  padding: 24px 18px;
}

.panel-error {
  min-height: 280px;
  padding: 10px;
}

.order-detail-popup {
  max-height: 88vh;
  overflow-y: auto;
}

.detail-sheet {
  width: 100%;
  max-width: 560px;
  margin: 0 auto;
  padding: 20px 17px max(20px, env(safe-area-inset-bottom));
}

.detail-sheet > header {
  padding: 2px 35px 17px 0;
  border-bottom: 1px solid var(--line);
}

.detail-sheet > header span,
.detail-sheet > header small {
  display: block;
}

.detail-sheet > header span {
  font-size: 19px;
  font-weight: 700;
}

.detail-sheet > header small {
  margin-top: 4px;
  overflow: hidden;
  color: var(--muted);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detail-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 19px 0;
}

.detail-summary > div:first-child span,
.detail-summary > div:first-child small,
.detail-summary > div:last-child strong,
.detail-summary > div:last-child > span {
  display: block;
}

.detail-summary > div:first-child span {
  font-size: 21px;
  font-weight: 750;
  letter-spacing: 0.07em;
}

.detail-summary > div:first-child small {
  margin-top: 5px;
  color: var(--muted);
  font-size: 11px;
}

.detail-summary > div:last-child {
  text-align: right;
}

.detail-summary > div:last-child strong {
  margin-bottom: 6px;
  color: var(--brand-dark);
  font-size: 21px;
}

.detail-list {
  margin: 0 0 17px;
  padding: 8px 12px;
  border-radius: 13px;
  background: #f6f7f8;
}

.detail-list > div {
  display: grid;
  grid-template-columns: 82px minmax(0, 1fr);
  gap: 10px;
  min-height: 42px;
  align-items: center;
  padding: 5px 0;
  border-bottom: 1px solid #e6e8ea;
}

.detail-list > div:last-child {
  border-bottom: 0;
}

.detail-list dt {
  color: var(--muted);
  font-size: 12px;
}

.detail-list dd {
  min-width: 0;
  margin: 0;
  color: #3f4145;
  font-size: 12px;
  line-height: 1.45;
  text-align: right;
  overflow-wrap: anywhere;
}

.detail-loading {
  display: grid;
  min-height: 240px;
  place-items: center;
}

.refund-panel {
  margin: 0 0 14px;
  padding: 14px;
  border: 1px solid #f0dfac;
  border-radius: 13px;
  background: #fffaf0;
}

.refund-panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.refund-panel-head h3 {
  margin: 0;
  font-size: 15px;
}

.refund-panel > p {
  margin: 9px 0 6px;
  color: #6d4d00;
  font-size: 12px;
  line-height: 1.5;
}

.refund-detail-list {
  margin: 8px 0 0;
}

.refund-detail-list > div {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  padding: 6px 0;
  font-size: 12px;
}

.refund-detail-list dt {
  color: var(--muted);
}

.refund-detail-list dd {
  margin: 0;
  text-align: right;
}

.refund-sync-button {
  margin-top: 8px;
}

.refund-action-button {
  margin: 0 0 10px;
}

.refund-uncertain {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 9px;
  margin-bottom: 12px;
  padding: 12px;
  border-radius: 12px;
  color: #6d4d00;
  background: var(--accent-soft);
  font-size: 12px;
  line-height: 1.5;
}

@media (max-width: 350px) {
  .admin-content {
    padding-right: 10px;
    padding-left: 10px;
  }

  .metric-card {
    padding: 13px 11px;
  }

  .filter-card :deep(.van-dropdown-menu__title) {
    max-width: 82px;
    font-size: 11px;
  }
}
</style>
