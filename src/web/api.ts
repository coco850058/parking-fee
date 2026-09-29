import type {
  AdminParkingLot,
  AdminSummary,
  Order,
  OrderFilters,
  OrderListResult,
  ParkingLot,
  PriceConfig,
  PriceItem,
  PublicSession,
  SummaryPeriod,
} from './types';

interface ErrorPayload {
  error?: { code?: string; message?: string };
}

export class ApiError extends Error {
  code: string;
  status: number;

  constructor(message: string, code = 'REQUEST_FAILED', status = 0) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

function toQuery(params: Record<string, unknown>) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      query.set(key, String(value));
    }
  });
  const value = query.toString();
  return value ? `?${value}` : '';
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers,
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError('网络连接失败，请检查网络后重试', 'NETWORK_ERROR');
  }

  const isJson = response.headers.get('content-type')?.includes('application/json');
  const payload = isJson ? ((await response.json()) as { data?: T } & ErrorPayload) : null;

  if (!response.ok) {
    throw new ApiError(
      payload?.error?.message || '请求失败，请稍后重试',
      payload?.error?.code || 'REQUEST_FAILED',
      response.status,
    );
  }

  if (!payload || !Object.prototype.hasOwnProperty.call(payload, 'data')) {
    throw new ApiError('服务返回格式异常', 'INVALID_RESPONSE', response.status);
  }
  return payload.data as T;
}

async function requestFile(path: string): Promise<Blob> {
  let response: Response;
  try {
    response = await fetch(path, { credentials: 'same-origin' });
  } catch {
    throw new ApiError('网络连接失败，请检查网络后重试', 'NETWORK_ERROR');
  }
  if (!response.ok) {
    const payload: ErrorPayload | null = response.headers.get('content-type')?.includes('application/json')
      ? ((await response.json()) as ErrorPayload)
      : null;
    throw new ApiError(
      payload?.error?.message || '导出失败，请稍后重试',
      payload?.error?.code || 'REQUEST_FAILED',
      response.status,
    );
  }
  return response.blob();
}

const json = (value: unknown) => JSON.stringify(value);

export const publicApi = {
  parkingLots: () => request<ParkingLot[]>('/api/public/parking-lots'),
  parkingLot: (id: string) =>
    request<ParkingLot>(`/api/public/parking-lots/${encodeURIComponent(id)}`),
  prices: (parkingLotId?: string) =>
    request<PriceConfig>(`/api/public/prices${toQuery({ parkingLotId })}`),
  session: (oauth?: { code?: string; state?: string; parkingLotId?: string }) =>
    request<PublicSession>(`/api/public/session${toQuery(oauth || {})}`),
  createOrder: (payload: {
    parkingLotId: string;
    clientRequestId: string;
    priceVersion: number;
    expectedAmount: number;
    customerType: string;
    address: string;
    plateNumber: string;
    durationMonths: number;
  }) => request<Order>('/api/public/orders', { method: 'POST', body: json(payload) }),
  order: (id: string | number) => request<Order>(`/api/public/orders/${encodeURIComponent(id)}`),
  orderHistory: (page = 1, pageSize = 20) =>
    request<OrderListResult>(`/api/public/orders/history${toQuery({ page, pageSize })}`),
  mockPay: (id: string | number) =>
    request<Order>(`/api/public/orders/${encodeURIComponent(id)}/mock-pay`, { method: 'POST' }),
  syncOrder: (id: string | number) =>
    request<Order>(`/api/public/orders/${encodeURIComponent(id)}/sync`, { method: 'POST' }),
};

export const adminApi = {
  login: (password: string) =>
    request<{ authenticated: boolean }>('/api/admin/login', {
      method: 'POST',
      body: json({ password }),
    }),
  logout: () => request<{ success?: boolean }>('/api/admin/logout', { method: 'POST' }),
  me: () => request<{ authenticated: boolean }>('/api/admin/me'),
  parkingLots: () => request<AdminParkingLot[]>('/api/admin/parking-lots'),
  createParkingLot: (name: string, platePrefix: string) =>
    request<AdminParkingLot>('/api/admin/parking-lots', {
      method: 'POST',
      body: json({ name, platePrefix }),
    }),
  updateParkingLot: (id: string, changes: { name?: string; platePrefix?: string; active?: boolean }) =>
    request<AdminParkingLot>(`/api/admin/parking-lots/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: json(changes),
    }),
  summary: (filters: { period: SummaryPeriod; year?: number; parkingLotId?: string }) =>
    request<AdminSummary>(`/api/admin/summary${toQuery(filters)}`),
  prices: (parkingLotId: string) =>
    request<PriceConfig>(`/api/admin/prices${toQuery({ parkingLotId })}`),
  savePrices: (parkingLotId: string, items: PriceItem[]) =>
    request<PriceConfig>(`/api/admin/prices${toQuery({ parkingLotId })}`, {
      method: 'PUT',
      body: json({ items }),
    }),
  orders: (filters: OrderFilters) =>
    request<OrderListResult>(`/api/admin/orders${toQuery(filters as Record<string, unknown>)}`),
  order: (id: string | number) => request<Order>(`/api/admin/orders/${encodeURIComponent(id)}`),
  refundOrder: (id: string | number) =>
    request<Order>(`/api/admin/orders/${encodeURIComponent(id)}/refund`, {
      method: 'POST',
      headers: { 'X-Parkfee-Admin-Action': 'refund' },
    }),
  syncRefund: (id: string | number) =>
    request<Order>(`/api/admin/orders/${encodeURIComponent(id)}/refund/sync`, {
      method: 'POST',
      headers: { 'X-Parkfee-Admin-Action': 'refund' },
    }),
  exportUrl: (filters: Omit<OrderFilters, 'page' | 'pageSize'>) =>
    `/api/admin/orders/export.csv${toQuery(filters as Record<string, unknown>)}`,
  exportOrders: (filters: Omit<OrderFilters, 'page' | 'pageSize'>) =>
    requestFile(`/api/admin/orders/export.csv${toQuery(filters as Record<string, unknown>)}`),
};

export function isUnauthorized(error: unknown) {
  return error instanceof ApiError && error.status === 401;
}
