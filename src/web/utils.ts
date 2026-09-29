import type { CustomerType, DurationMonths, OrderStatus, WechatPaymentParams } from './types';

export const plateProvinces = Array.from('京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼');
export const plateLetters = Array.from('ABCDEFGHJKLMNPQRSTUVWXYZ');

export const customerTypeText: Record<CustomerType, string> = {
  merchant: '商户租户',
  resident: '居民',
};

export const durationText: Record<DurationMonths, string> = {
  1: '1个月',
  3: '3个月',
  6: '半年',
  12: '一年',
};

export const statusText: Record<OrderStatus, string> = {
  pending: '待支付',
  paid: '已支付',
  closed: '已关闭',
  refunded: '已退款',
};

export const statusTone: Record<OrderStatus, string> = {
  pending: 'warning',
  paid: 'success',
  closed: 'muted',
  refunded: 'info',
};

export function formatMoney(cents?: number | null) {
  const amount = Number(cents || 0) / 100;
  return amount.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function formatDateTime(value?: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
    .format(date)
    .replaceAll('/', '-');
}

export function normalizePlate(value: string) {
  return value.trim().replace(/[\s\-·]/g, '').toUpperCase();
}

export function isValidPlate(value: string) {
  const plate = normalizePlate(value);
  const prefix = '[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼][A-HJ-NP-Z]';
  return (
    new RegExp(`^${prefix}[A-HJ-NP-Z0-9]{5}$`).test(plate) ||
    new RegExp(`^${prefix}[DF][A-HJ-NP-Z0-9][0-9]{4}$`).test(plate) ||
    new RegExp(`^${prefix}[0-9]{5}[DF]$`).test(plate)
  );
}

export function localDate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

interface BridgeResult {
  err_msg?: string;
}

declare global {
  interface Window {
    WeixinJSBridge?: {
      invoke: (
        method: string,
        params: WechatPaymentParams,
        callback: (result: BridgeResult) => void,
      ) => void;
    };
  }
}

function waitForWechatBridge(timeoutMs = 8000) {
  if (window.WeixinJSBridge) return Promise.resolve(window.WeixinJSBridge);

  return new Promise<NonNullable<Window['WeixinJSBridge']>>((resolve, reject) => {
    let settled = false;
    const timeout = window.setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('未检测到微信支付环境，请在微信中打开页面'));
      }
    }, timeoutMs);

    const ready = () => {
      if (settled || !window.WeixinJSBridge) return;
      settled = true;
      window.clearTimeout(timeout);
      document.removeEventListener('WeixinJSBridgeReady', ready);
      resolve(window.WeixinJSBridge);
    };
    document.addEventListener('WeixinJSBridgeReady', ready, false);
  });
}

export async function invokeWechatPay(params: WechatPaymentParams) {
  const bridge = await waitForWechatBridge();
  return new Promise<'ok' | 'cancel'>((resolve, reject) => {
    bridge.invoke('getBrandWCPayRequest', params, (result) => {
      const message = result.err_msg || '';
      if (message.endsWith(':ok')) resolve('ok');
      else if (message.endsWith(':cancel')) resolve('cancel');
      else reject(new Error('微信支付未完成，请稍后重试'));
    });
  });
}
