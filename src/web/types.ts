export type CustomerType = 'merchant' | 'resident';
export type DurationMonths = 1 | 3 | 6 | 12;
export type OrderStatus = 'pending' | 'paid' | 'closed' | 'refunded';
export type PaymentMode = 'mock' | 'wechat';
export type RefundStatus = 'requesting' | 'processing' | 'success' | 'closed' | 'abnormal';

export interface Refund {
  status: RefundStatus;
  amount: number;
  requestedAt: string;
  successAt: string | null;
}

export interface PriceItem {
  customerType: CustomerType;
  durationMonths: DurationMonths;
  amount: number;
}

export interface PriceConfig {
  version: number | string;
  enabled: boolean;
  items: PriceItem[];
}

export interface ParkingLot {
  id: string;
  name: string;
  platePrefix: string;
}

export interface AdminParkingLot extends ParkingLot {
  active: boolean;
  paymentUrl: string;
  createdAt: string;
  updatedAt: string;
}

export interface PublicSession {
  openid?: string | null;
  oauthRequired: boolean;
  paymentMode: PaymentMode;
  authorizationUrl?: string | null;
  resumeParkingLotId?: string | null;
}

export interface WechatPaymentParams {
  appId: string;
  timeStamp: string;
  nonceStr: string;
  package: string;
  signType: string;
  paySign: string;
}

export interface Order {
  id: string | number;
  orderNo: string;
  parkingLotId?: string;
  parkingLotName?: string;
  status: OrderStatus;
  amount: number;
  priceVersion: number | string;
  customerType: CustomerType;
  address: string;
  plateNumber: string;
  durationMonths: DurationMonths;
  createdAt: string;
  expiresAt?: string;
  paidAt?: string | null;
  transactionId?: string | null;
  paymentParams?: WechatPaymentParams;
  refund?: Refund | null;
}

export interface SummaryBucket {
  count: number;
  amount: number;
}

export interface AdminSummary {
  today: SummaryBucket;
  month: SummaryBucket;
  all: SummaryBucket;
  pendingCount: number;
  selected: SummaryBucket;
  availableYears: number[];
}

export type SummaryPeriod = 'today' | 'week' | 'month' | 'year';

export interface OrderListResult {
  items: Order[];
  total: number;
  page: number;
  pageSize: number;
}

export interface OrderFilters {
  page?: number;
  pageSize?: number;
  from?: string;
  to?: string;
  status?: OrderStatus | '';
  customerType?: CustomerType | '';
  durationMonths?: DurationMonths | '';
  keyword?: string;
  parkingLotId?: string;
}
