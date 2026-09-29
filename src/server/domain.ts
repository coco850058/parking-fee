import { z } from 'zod'

export const customerTypes = ['merchant', 'resident'] as const
export const durationOptions = [1, 3, 6, 12] as const
export const orderStatuses = ['pending', 'paid', 'closed', 'refunded'] as const

export type CustomerType = (typeof customerTypes)[number]
export type DurationMonths = (typeof durationOptions)[number]
export type OrderStatus = (typeof orderStatuses)[number]
export type RefundStatus = 'requesting' | 'processing' | 'success' | 'closed' | 'abnormal'

export interface RefundRecord {
  status: RefundStatus
  amount: number
  requestedAt: string
  successAt: string | null
}

export const customerTypeSchema = z.enum(customerTypes, {
  error: '请选择用户类型',
})
export const durationSchema = z.union(
  durationOptions.map((duration) => z.literal(duration)) as [
    z.ZodLiteral<1>,
    z.ZodLiteral<3>,
    z.ZodLiteral<6>,
    z.ZodLiteral<12>,
  ],
  { error: '请选择有效的缴费时长' },
)

export function normalizePlateNumber(value: string): string {
  return value.trim().toUpperCase().replace(/[\s\-·]/g, '')
}

// 普通汽车号牌为「省份简称 + 发牌机关字母 + 5 位序号」；新能源号牌
// 的 6 位序号分为小型（D/F 开头）与大型（D/F 结尾）两种编排。
export const DEFAULT_PLATE_PREFIX = '新A'
const platePrefixPatternSource = '[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼][A-HJ-NP-Z]'
const platePrefixPattern = new RegExp(`^${platePrefixPatternSource}$`)
const ordinaryPlatePattern = new RegExp(`^${platePrefixPatternSource}[A-HJ-NP-Z0-9]{5}$`)
const smallNewEnergyPlatePattern = new RegExp(`^${platePrefixPatternSource}[DF][A-HJ-NP-Z0-9][0-9]{4}$`)
const largeNewEnergyPlatePattern = new RegExp(`^${platePrefixPatternSource}[0-9]{5}[DF]$`)

export const platePrefixSchema = z
  .string()
  .transform(normalizePlateNumber)
  .refine((value) => platePrefixPattern.test(value), '请输入有效的省份简称及发牌字母，如“新A”')

export function isValidPlateNumber(value: string): boolean {
  return (
    ordinaryPlatePattern.test(value) ||
    smallNewEnergyPlatePattern.test(value) ||
    largeNewEnergyPlatePattern.test(value)
  )
}

export const plateNumberSchema = z
  .string()
  .transform(normalizePlateNumber)
  .refine(isValidPlateNumber, '请输入有效的 7 位普通车牌或 8 位新能源车牌')

export const createOrderSchema = z.object({
  parkingLotId: z.string().uuid('停车场编号格式不正确').optional(),
  clientRequestId: z.string().uuid('请求标识格式不正确'),
  priceVersion: z.number().int('价格版本格式不正确').positive('价格版本格式不正确'),
  expectedAmount: z
    .number()
    .int('预期金额必须是整数分')
    .min(0, '预期金额不能小于0')
    .max(10_000_000, '预期金额过大'),
  customerType: customerTypeSchema,
  address: z.string().trim().min(2, '请填写地址').max(120, '地址不能超过120个字符'),
  plateNumber: plateNumberSchema,
  durationMonths: durationSchema,
})

export const priceItemSchema = z.object({
  customerType: customerTypeSchema,
  durationMonths: durationSchema,
  amount: z.number().int('金额必须是整数分').min(0, '金额不能小于0').max(10_000_000, '金额过大'),
})

export const updatePricesSchema = z.object({
  items: z.array(priceItemSchema).length(8, '必须提交全部8项价格'),
})

export interface PriceItem {
  customerType: CustomerType
  durationMonths: DurationMonths
  amount: number
}

export interface PriceList {
  version: number
  enabled: boolean
  items: PriceItem[]
}

export interface OrderRecord {
  id: string
  orderNo: string
  parkingLotId: string
  parkingLotName: string
  clientRequestId: string
  openid: string
  customerType: CustomerType
  address: string
  plateNumber: string
  durationMonths: DurationMonths
  amount: number
  priceVersion: number
  status: OrderStatus
  paymentMode: 'mock' | 'wechat'
  transactionId: string | null
  createdAt: string
  expiresAt: string
  updatedAt: string
  paidAt: string | null
  refund: RefundRecord | null
}
