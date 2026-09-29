import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import cookie from '@fastify/cookie'
import jwt from '@fastify/jwt'
import fastifyStatic from '@fastify/static'
import bcrypt from 'bcryptjs'
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify'
import { z } from 'zod'
import { type AppConfig, type Environment, loadConfig } from './config.js'
import {
  applyRefundResult,
  auditRefundError,
  claimRefundPoll,
  claimRefundSubmission,
  closeOrder,
  createParkingLot,
  createRefundIntent,
  expirePendingOrders,
  exportOrders,
  findPrice,
  getCurrentPrices,
  getOrderByClientRequestId,
  getOrderById,
  getOrderByNo,
  getParkingLot,
  getPrepayId,
  getRefundIntent,
  getSummary,
  insertOrder,
  listOrders,
  listParkingLots,
  listPaymentHistory,
  listRefundIntentsForPoll,
  openDatabase,
  recordPayment,
  replacePrices,
  resolvePublicParkingLot,
  savePrepayId,
  updateParkingLot,
  type OrderFilters,
  type ParkingDatabase,
  type RefundIntent,
} from './database.js'
import {
  createOrderSchema,
  customerTypeSchema,
  durationSchema,
  orderStatuses,
  platePrefixSchema,
  updatePricesSchema,
  type OrderRecord,
} from './domain.js'
import { AppError, sendError } from './errors.js'
import { parseCalendarDate, shanghaiDateParts, shanghaiDayStartIso } from './dates.js'
import { WechatPayClient, type JsapiPaymentParams, type WechatRefund, type WechatTransaction } from './wechat.js'

const ADMIN_COOKIE = 'park_admin'
const PUBLIC_COOKIE = 'park_session'
const OAUTH_STATE_COOKIE = 'park_oauth_state'

interface TokenClaims {
  role: 'admin' | 'public' | 'oauth'
  openid?: string
  state?: string
  parkingLotId?: string
}

export interface CreateAppOptions {
  env?: Environment
  databasePath?: string
  logger?: FastifyServerOptions['logger']
  fetch?: typeof fetch
  now?: () => Date
  serveStatic?: boolean
  refundPollIntervalMs?: number
}

interface AppContext {
  app: FastifyInstance
  config: AppConfig
  db: ParkingDatabase
  wechat: WechatPayClient
  now: () => Date
  refundPollIntervalMs: number
}

interface LoginAttempt {
  failures: number
  resetAt: number
  blockedUntil: number
}

const LOGIN_WINDOW_MS = 15 * 60 * 1000
const LOGIN_MAX_FAILURES = 5
const MAX_TRACKED_LOGIN_IPS = 1_000
const ORDER_TTL_MS = 2 * 60 * 60 * 1000
const CREATE_RATE_WINDOW_MS = 60 * 1000
const CREATE_RATE_LIMIT = 10
const SYNC_MIN_INTERVAL_MS = 2_000
const REFUND_QUERY_MIN_INTERVAL_MS = 5_000
const REFUND_WINDOW_MS = 365 * 24 * 60 * 60 * 1000
const MAX_TRACKED_PUBLIC_KEYS = 5_000
const MAX_EXPORT_ROWS = 20_000

interface RateWindow {
  count: number
  resetAt: number
}

function enforceWindowRateLimit(
  entries: Map<string, RateWindow>,
  key: string,
  nowMs: number,
  limit: number,
  windowMs: number,
  code: string,
  message: string,
): void {
  const existing = entries.get(key)
  const entry =
    existing && existing.resetAt > nowMs
      ? existing
      : { count: 0, resetAt: nowMs + windowMs }
  if (entry.count >= limit) throw new AppError(429, code, message)
  entry.count += 1
  if (!entries.has(key) && entries.size >= MAX_TRACKED_PUBLIC_KEYS) {
    const oldest = entries.keys().next().value as string | undefined
    if (oldest) entries.delete(oldest)
  }
  // 重新插入可让 Map 的迭代顺序大致反映最近使用时间。
  entries.delete(key)
  entries.set(key, entry)
}

function enforceSyncInterval(
  entries: Map<string, number>,
  key: string,
  nowMs: number,
  minIntervalMs = SYNC_MIN_INTERVAL_MS,
): void {
  const previous = entries.get(key)
  if (previous !== undefined && nowMs - previous < minIntervalMs) {
    throw new AppError(429, 'ORDER_SYNC_RATE_LIMITED', '查询过于频繁，请稍后再试')
  }
  if (!entries.has(key) && entries.size >= MAX_TRACKED_PUBLIC_KEYS) {
    const oldest = entries.keys().next().value as string | undefined
    if (oldest) entries.delete(oldest)
  }
  entries.delete(key)
  entries.set(key, nowMs)
}

function assertLoginAllowed(attempts: Map<string, LoginAttempt>, ip: string, nowMs: number): void {
  const attempt = attempts.get(ip)
  if (!attempt) return
  if (attempt.resetAt <= nowMs && attempt.blockedUntil <= nowMs) {
    attempts.delete(ip)
    return
  }
  if (attempt.blockedUntil > nowMs) {
    throw new AppError(429, 'LOGIN_RATE_LIMITED', '登录尝试过多，请15分钟后再试')
  }
}

function recordLoginFailure(attempts: Map<string, LoginAttempt>, ip: string, nowMs: number): void {
  const existing = attempts.get(ip)
  const attempt =
    existing && existing.resetAt > nowMs
      ? existing
      : { failures: 0, resetAt: nowMs + LOGIN_WINDOW_MS, blockedUntil: 0 }
  attempt.failures += 1
  if (attempt.failures >= LOGIN_MAX_FAILURES) attempt.blockedUntil = nowMs + LOGIN_WINDOW_MS
  // Map 有大小上限，避免伪造大量来源地址造成无界内存增长。
  if (!attempts.has(ip) && attempts.size >= MAX_TRACKED_LOGIN_IPS) {
    const oldest = attempts.keys().next().value as string | undefined
    if (oldest) attempts.delete(oldest)
  }
  attempts.set(ip, attempt)
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

function safePlainTextEqual(actual: string, expected: string): boolean {
  return sha256(actual).equals(sha256(expected))
}

function orderNumber(now: Date): string {
  const timestamp = now
    .toISOString()
    .replace(/[-:TZ.]/g, '')
    .slice(0, 14)
  return `PF${timestamp}${randomBytes(5).toString('hex').toUpperCase()}`
}

function safeOrder(order: OrderRecord): Omit<OrderRecord, 'openid' | 'clientRequestId'> {
  const { openid: _openid, clientRequestId: _clientRequestId, ...safe } = order
  return safe
}

function paymentParamsFor(context: AppContext, order: OrderRecord): JsapiPaymentParams | null {
  if (context.config.paymentMode !== 'wechat' || order.status !== 'pending') return null
  if (new Date(order.expiresAt).getTime() <= context.now().getTime()) return null
  const prepayId = getPrepayId(context.db, order.id)
  return prepayId ? context.wechat.buildJsapiPaymentParams(prepayId) : null
}

function assertIdempotentPayload(
  order: OrderRecord,
  input: z.infer<typeof createOrderSchema>,
  parkingLotId: string,
): void {
  if (
    order.parkingLotId !== parkingLotId ||
    order.customerType !== input.customerType ||
    order.address !== input.address ||
    order.plateNumber !== input.plateNumber ||
    order.durationMonths !== input.durationMonths ||
    order.priceVersion !== input.priceVersion ||
    order.amount !== input.expectedAmount
  ) {
    throw new AppError(
      409,
      'IDEMPOTENCY_CONFLICT',
      '该请求标识已用于另一笔订单，请刷新页面后重试',
    )
  }
}

function dateBoundary(value: string | undefined, end: boolean): string | undefined {
  if (!value) return undefined
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = parseCalendarDate(value)
    if (!date) throw new AppError(400, 'INVALID_DATE', '日期格式不正确')
    return shanghaiDayStartIso(date.year, date.month, date.day + Number(end))
  }
  // 兼容原有带时区的 ISO 时间戳，但拒绝可被 Date 自动滚动的非法日历日期，
  // 以及会依赖服务器本地时区解释的无时区输入。
  const timestamp = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value)
  if (
    !timestamp ||
    !parseCalendarDate(timestamp[1]) ||
    Number(timestamp[2]) > 23 ||
    Number(timestamp[3]) > 59 ||
    Number(timestamp[4]) > 59
  ) {
    throw new AppError(400, 'INVALID_DATE', '日期格式不正确')
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) throw new AppError(400, 'INVALID_DATE', '日期格式不正确')
  // 时间戳保持原有的包含结束时刻语义，日期则已归一化为次日零点。
  return new Date(parsed.getTime() + Number(end)).toISOString()
}

const idParamsSchema = z.object({ id: z.string().uuid('订单编号格式不正确') })
const loginSchema = z.object({
  password: z.string().min(1, '请输入管理员密码').max(200, '密码过长'),
})
const sessionQuerySchema = z.object({
  code: z.string().min(1).max(256).optional(),
  state: z.string().min(1).max(256).optional(),
  parkingLotId: z.string().uuid().optional(),
})
const parkingLotQuerySchema = z.object({ parkingLotId: z.string().uuid().optional() })
const parkingLotParamsSchema = z.object({ id: z.string().uuid() })
const parkingLotCreateSchema = z.object({
  name: z.string().trim().min(2, '请输入停车场名称').max(80, '停车场名称不能超过80个字符'),
  platePrefix: platePrefixSchema.optional(),
}).strict()
const parkingLotUpdateSchema = parkingLotCreateSchema.partial().extend({
  active: z.boolean().optional(),
}).strict().refine((input) =>
  input.name !== undefined || input.platePrefix !== undefined || input.active !== undefined,
  '请指定要修改的内容',
)
const orderQuerySchema = z.object({
  parkingLotId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
  status: z.enum(orderStatuses).optional(),
  customerType: customerTypeSchema.optional(),
  durationMonths: z.coerce.number().pipe(durationSchema).optional(),
  keyword: z.string().trim().max(100).optional(),
})
const summaryQuerySchema = z.object({
  parkingLotId: z.string().uuid().optional(),
  period: z.enum(['today', 'week', 'month', 'year']).default('today'),
  year: z.coerce.number().int().min(1900).max(9999).optional(),
})
const historyQuerySchema = orderQuerySchema.pick({ page: true, pageSize: true })
const refundRequestSchema = z.object({
  reason: z.string().trim().min(1).max(80).optional(),
}).strict()

async function tokenClaims(
  context: AppContext,
  request: FastifyRequest,
  cookieName: string,
): Promise<TokenClaims | null> {
  const token = request.cookies[cookieName]
  if (!token) return null
  try {
    return await context.app.jwt.verify<TokenClaims>(token)
  } catch {
    return null
  }
}

async function requireAdmin(context: AppContext, request: FastifyRequest): Promise<TokenClaims> {
  const claims = await tokenClaims(context, request, ADMIN_COOKIE)
  if (!claims || claims.role !== 'admin') {
    throw new AppError(401, 'ADMIN_AUTH_REQUIRED', '请先登录管理后台')
  }
  return claims
}

async function publicOpenid(context: AppContext, request: FastifyRequest): Promise<string> {
  if (context.config.paymentMode === 'mock') return 'mock-openid'
  const claims = await tokenClaims(context, request, PUBLIC_COOKIE)
  if (!claims?.openid || claims.role !== 'public') {
    throw new AppError(401, 'WECHAT_AUTH_REQUIRED', '请先完成微信身份验证')
  }
  return claims.openid
}

function assertOrderOwner(order: OrderRecord, openid: string): void {
  if (order.openid !== openid) throw new AppError(404, 'ORDER_NOT_FOUND', '订单不存在')
}

function validateWechatTransaction(
  config: AppConfig,
  order: OrderRecord,
  transaction: WechatTransaction,
): void {
  if (
    transaction.appid !== config.wechat.appId ||
    transaction.mchid !== config.wechat.mchId ||
    transaction.out_trade_no !== order.orderNo ||
    transaction.amount?.total !== order.amount
  ) {
    throw new AppError(400, 'WECHAT_PAYMENT_MISMATCH', '微信支付订单信息校验失败')
  }
  if (transaction.trade_state === 'SUCCESS' && !transaction.transaction_id) {
    throw new AppError(400, 'WECHAT_PAYMENT_INVALID', '微信支付交易号缺失')
  }
}

function requireWechatTransactionId(transaction: WechatTransaction): string {
  if (!transaction.transaction_id) {
    throw new AppError(400, 'WECHAT_PAYMENT_INVALID', '微信支付交易号缺失')
  }
  return transaction.transaction_id
}

function wechatPaidAt(value: string | undefined, fallback: string): string {
  if (!value) return fallback
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString()
}

function validateWechatRefund(
  config: AppConfig,
  order: OrderRecord,
  intent: RefundIntent,
  result: WechatRefund,
  requireMchid = false,
): Exclude<NonNullable<OrderRecord['refund']>['status'], 'requesting'> {
  if (
    (requireMchid && !result.mchid) ||
    (result.mchid && result.mchid !== config.wechat.mchId) ||
    !result.refund_id ||
    result.out_trade_no !== order.orderNo ||
    result.transaction_id !== order.transactionId ||
    result.out_refund_no !== intent.outRefundNo ||
    result.amount?.total !== order.amount ||
    result.amount?.refund !== intent.amount ||
    (result.amount?.currency && result.amount.currency !== 'CNY') ||
    (intent.wechatRefundId && intent.wechatRefundId !== result.refund_id)
  ) {
    throw new AppError(400, 'WECHAT_REFUND_MISMATCH', '微信退款订单信息校验失败')
  }
  const statuses = {
    SUCCESS: 'success',
    CLOSED: 'closed',
    PROCESSING: 'processing',
    ABNORMAL: 'abnormal',
  } as const
  const status = statuses[result.status]
  if (!status) throw new AppError(400, 'WECHAT_REFUND_INVALID', '微信退款状态无效')
  return status
}

function assertRefundAdminAction(config: AppConfig, request: FastifyRequest): void {
  if (request.headers['x-parkfee-admin-action'] !== 'refund') {
    throw new AppError(403, 'REFUND_ACTION_HEADER_REQUIRED', '退款操作需要明确确认')
  }
  const origin = request.headers.origin
  if (origin && origin !== new URL(config.publicBaseUrl).origin) {
    throw new AppError(403, 'REFUND_ORIGIN_INVALID', '退款请求来源不正确')
  }
}

function parseFilters(query: unknown): OrderFilters {
  const parsed = orderQuerySchema.parse(query)
  const from = dateBoundary(parsed.from, false)
  const to = dateBoundary(parsed.to, true)
  if (from && to && from >= to) {
    throw new AppError(400, 'INVALID_DATE_RANGE', '结束日期不能早于开始日期')
  }
  return {
    page: parsed.page,
    pageSize: parsed.pageSize,
    parkingLotId: parsed.parkingLotId,
    from,
    to,
    status: parsed.status,
    customerType: parsed.customerType,
    durationMonths: parsed.durationMonths,
    keyword: parsed.keyword || undefined,
  }
}

function csvCell(value: string | number | null): string {
  let text = value === null ? '' : String(value)
  // 防止地址、车牌等用户输入在 Excel/WPS 打开时被当作公式执行。
  if (/^[=+\-@]/.test(text)) text = `'${text}`
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function ordersCsv(orders: OrderRecord[]): string {
  const rows: Array<Array<string | number | null>> = [
    ['订单号', '停车场', '状态', '用户类型', '地址', '车牌号', '时长（月）', '金额（分）', '创建时间', '支付时间', '微信交易号', '退款状态', '退款金额（分）', '退款成功时间'],
    ...orders.map((order) => [
      order.orderNo,
      order.parkingLotName,
      order.status,
      order.customerType,
      order.address,
      order.plateNumber,
      order.durationMonths,
      order.amount,
      order.createdAt,
      order.paidAt,
      order.transactionId,
      order.refund?.status ?? null,
      order.refund?.amount ?? null,
      order.refund?.successAt ?? null,
    ]),
  ]
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}`
}

function paymentUrl(baseUrl: string, parkingLotId: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/#/pay/${parkingLotId}`
}

async function registerRoutes(context: AppContext): Promise<void> {
  const { app, config, db, wechat, now } = context
  const loginAttempts = new Map<string, LoginAttempt>()
  const createRateWindows = new Map<string, RateWindow>()
  const syncTimestamps = new Map<string, number>()
  const refundQueryTimestamps = new Map<string, number>()
  const applyWechatRefund = (
    order: OrderRecord,
    intent: RefundIntent,
    result: WechatRefund,
    source: 'wechat:request' | 'wechat:query' | 'wechat:callback',
    eventId?: string,
    eventType = 'REFUND.QUERY',
    rawPayload = JSON.stringify(result),
  ): OrderRecord => {
    const status = validateWechatRefund(config, order, intent, result, source === 'wechat:callback')
    return applyRefundResult(db, {
      orderId: order.id,
      status,
      wechatRefundId: result.refund_id,
      successAt: status === 'success'
        ? wechatPaidAt(result.success_time, now().toISOString())
        : null,
      eventId,
      eventType,
      rawPayload,
      actor: source,
      now: now().toISOString(),
    })
  }
  const queryWechatRefund = async (order: OrderRecord, intent: RefundIntent): Promise<OrderRecord | null> => {
    try {
      const result = await wechat.queryRefund(intent.outRefundNo)
      return applyWechatRefund(order, intent, result, 'wechat:query')
    } catch (error) {
      if (
        error instanceof AppError &&
        ['WECHAT_RESOURCE_NOT_EXISTS', 'WECHAT_RESOURCE_NOT_FOUND', 'WECHAT_REFUND_NOT_EXIST'].includes(error.code)
      ) return null
      throw error
    }
  }
  if (config.paymentMode === 'wechat') {
    let pollInFlight: Promise<void> | null = null
    const pollRefunds = async (): Promise<void> => {
      const candidates = listRefundIntentsForPoll(db, now().toISOString(), 10)
      for (const intent of candidates) {
        if (!claimRefundPoll(db, intent.orderId, now().toISOString())) continue
        try {
          await queryWechatRefund(getOrderById(db, intent.orderId), intent)
        } catch (error) {
          const code = error instanceof AppError ? error.code : 'UNKNOWN'
          auditRefundError(db, intent.orderId, 'refund.poll.error', code, now().toISOString())
          app.log.warn({ err: error, orderId: intent.orderId }, '微信退款自动查单失败')
        }
      }
    }
    const timer = setInterval(() => {
      if (pollInFlight) return
      pollInFlight = pollRefunds()
        .catch((error) => app.log.error({ err: error }, '微信退款自动查单批次失败'))
        .finally(() => { pollInFlight = null })
    }, context.refundPollIntervalMs)
    timer.unref()
    app.addHook('onClose', async () => {
      clearInterval(timer)
      if (pollInFlight) await pollInFlight
    })
  }
  const compensateCloseWechatOrder = async (order: OrderRecord): Promise<void> => {
    try {
      closeOrder(db, order.id, now().toISOString())
    } catch (closeError) {
      // 不用补偿异常覆盖原始预下单异常，同时留下可检索日志供人工处理。
      app.log.error({ err: closeError, orderId: order.id }, '微信预下单失败后的本地关单失败')
    }
    try {
      await wechat.closeOrder(order.orderNo)
    } catch (closeError) {
      app.log.warn({ err: closeError, orderId: order.id }, '微信订单补偿关单失败')
    }
  }

  app.get('/api/health', async () => ({
    data: { status: 'ok', time: now().toISOString() },
  }))

  app.get('/api/public/parking-lots', async () => ({
    data: listParkingLots(db).map(({ id, name, platePrefix }) => ({ id, name, platePrefix })),
  }))

  app.get('/api/public/parking-lots/:id', async (request) => {
    const { id } = parkingLotParamsSchema.parse(request.params)
    const lot = getParkingLot(db, id, true)
    return { data: { id: lot.id, name: lot.name, platePrefix: lot.platePrefix } }
  })

  app.get('/api/public/prices', async (request) => {
    const { parkingLotId } = parkingLotQuerySchema.parse(request.query)
    const lot = resolvePublicParkingLot(db, parkingLotId)
    const { versionId: _versionId, ...prices } = getCurrentPrices(db, lot.id)
    return { data: prices }
  })

  app.get('/api/public/session', async (request, reply) => {
    const query = sessionQuerySchema.parse(request.query)
    // 历史页无需停车场；扫码支付页必须在授权前绑定有效场地。
    if (query.parkingLotId) getParkingLot(db, query.parkingLotId, true)
    if (config.paymentMode === 'mock') {
      return {
        data: {
          oauthRequired: false,
          paymentMode: 'mock',
          authorizationUrl: null,
          resumeParkingLotId: query.parkingLotId ?? null,
        },
      }
    }

    if (query.code) {
      const oauthClaims = await tokenClaims(context, request, OAUTH_STATE_COOKIE)
      if (
        !query.state ||
        oauthClaims?.role !== 'oauth' ||
        !oauthClaims.state ||
        !safePlainTextEqual(query.state, oauthClaims.state) ||
        (query.parkingLotId && query.parkingLotId !== oauthClaims.parkingLotId)
      ) {
        throw new AppError(400, 'WECHAT_OAUTH_STATE_INVALID', '微信身份验证状态已失效，请重新扫码')
      }
      if (oauthClaims.parkingLotId) getParkingLot(db, oauthClaims.parkingLotId, true)
      const openid = await wechat.exchangeOAuthCode(query.code)
      const token = app.jwt.sign({ role: 'public', openid } satisfies TokenClaims, {
        expiresIn: '30d',
      })
      void reply.setCookie(PUBLIC_COOKIE, token, {
        httpOnly: true,
        secure: config.isProduction,
        sameSite: 'lax',
        path: '/',
        maxAge: 30 * 24 * 60 * 60,
      })
      void reply.clearCookie(OAUTH_STATE_COOKIE, { path: '/' })
      return {
        data: {
          oauthRequired: false,
          paymentMode: 'wechat',
          authorizationUrl: null,
          resumeParkingLotId: oauthClaims.parkingLotId ?? null,
        },
      }
    }

    if (query.state) {
      throw new AppError(400, 'WECHAT_OAUTH_STATE_INVALID', '微信身份验证状态已失效，请重新扫码')
    }

    const existing = await tokenClaims(context, request, PUBLIC_COOKIE)
    if (existing?.role === 'public' && existing.openid) {
      return {
        data: {
          oauthRequired: false,
          paymentMode: 'wechat',
          authorizationUrl: null,
          resumeParkingLotId: query.parkingLotId ?? null,
        },
      }
    }

    const state = randomBytes(24).toString('hex')
    const stateToken = app.jwt.sign({ role: 'oauth', state, parkingLotId: query.parkingLotId } satisfies TokenClaims, {
      expiresIn: '10m',
    })
    void reply.setCookie(OAUTH_STATE_COOKIE, stateToken, {
      httpOnly: true,
      secure: config.isProduction,
      sameSite: 'lax',
      path: '/',
      maxAge: 10 * 60,
    })
    return {
      data: {
        oauthRequired: true,
        paymentMode: 'wechat',
        authorizationUrl: wechat.buildOAuthUrl(state),
        resumeParkingLotId: null,
      },
    }
  })

  app.post('/api/public/orders', async (request, reply) => {
    const input = createOrderSchema.parse(request.body)
    const openid = await publicOpenid(context, request)
    const createdAt = now()
    enforceWindowRateLimit(
      createRateWindows,
      `${openid}:${request.ip}`,
      createdAt.getTime(),
      CREATE_RATE_LIMIT,
      CREATE_RATE_WINDOW_MS,
      'ORDER_CREATE_RATE_LIMITED',
      '创建订单过于频繁，请稍后再试',
    )
    const result = db.transaction(() => {
      expirePendingOrders(db, createdAt.toISOString())
      const existing = getOrderByClientRequestId(db, openid, input.clientRequestId)
      const parkingLotId = input.parkingLotId ?? resolvePublicParkingLot(db).id
      if (existing) {
        assertIdempotentPayload(existing, input, parkingLotId)
        return { order: existing, created: false }
      }
      const lot = getParkingLot(db, parkingLotId, true)
      const prices = getCurrentPrices(db, lot.id)
      if (input.priceVersion !== prices.version) {
        throw new AppError(409, 'PRICE_CHANGED', '缴费标准已更新，请确认最新金额')
      }
      const amount = findPrice(prices, input.customerType, input.durationMonths)
      if (input.expectedAmount !== amount) {
        throw new AppError(409, 'PRICE_CHANGED', '缴费金额已更新，请确认最新金额')
      }
      const expiresAt = new Date(createdAt.getTime() + ORDER_TTL_MS).toISOString()
      const order = insertOrder(db, {
        id: randomUUID(),
        orderNo: orderNumber(createdAt),
        parkingLotId: lot.id,
        parkingLotName: lot.name,
        clientRequestId: input.clientRequestId,
        openid,
        customerType: input.customerType,
        address: input.address,
        plateNumber: input.plateNumber,
        durationMonths: input.durationMonths,
        amount,
        priceVersion: prices.version,
        priceVersionId: prices.versionId,
        paymentMode: config.paymentMode,
        now: createdAt.toISOString(),
        expiresAt,
      })
      return { order, created: true }
    })()

    const { order } = result
    let paymentParams = paymentParamsFor(context, order)
    if (config.paymentMode === 'wechat' && order.status === 'pending' && !paymentParams) {
      let prepay: Awaited<ReturnType<WechatPayClient['createJsapiOrder']>>
      try {
        prepay = await wechat.createJsapiOrder(order)
      } catch (error) {
        await compensateCloseWechatOrder(order)
        throw error
      }
      const saved = savePrepayId(db, order.id, prepay.prepayId, now().toISOString())
      if (!saved) {
        await compensateCloseWechatOrder(order)
        throw new AppError(409, 'ORDER_EXPIRED', '订单已过期，请重新提交')
      }
      paymentParams = prepay.paymentParams
    }
    void reply.status(result.created ? 201 : 200)
    return { data: { ...safeOrder(order), paymentParams } }
  })

  app.get('/api/public/orders/history', async (request) => {
    const { page, pageSize } = historyQuerySchema.parse(request.query)
    const openid = await publicOpenid(context, request)
    const result = listPaymentHistory(db, openid, page, pageSize)
    return { data: { ...result, items: result.items.map(safeOrder) } }
  })

  app.get('/api/public/orders/:id', async (request) => {
    const { id } = idParamsSchema.parse(request.params)
    const openid = await publicOpenid(context, request)
    expirePendingOrders(db, now().toISOString())
    const order = getOrderById(db, id)
    assertOrderOwner(order, openid)
    return { data: { ...safeOrder(order), paymentParams: paymentParamsFor(context, order) } }
  })

  app.post('/api/public/orders/:id/mock-pay', async (request) => {
    if (config.paymentMode !== 'mock') {
      throw new AppError(404, 'NOT_FOUND', '接口不存在')
    }
    const { id } = idParamsSchema.parse(request.params)
    const openid = await publicOpenid(context, request)
    expirePendingOrders(db, now().toISOString())
    const order = getOrderById(db, id)
    assertOrderOwner(order, openid)
    const paid = recordPayment(db, {
      eventId: `mock:${id}`,
      eventType: 'MOCK.PAYMENT.SUCCESS',
      orderId: id,
      transactionId: `MOCK-${id}`,
      rawPayload: JSON.stringify({ mock: true, orderId: id }),
      paidAt: now().toISOString(),
      now: now().toISOString(),
    }).order
    return { data: safeOrder(paid) }
  })

  app.post('/api/public/orders/:id/sync', async (request) => {
    const { id } = idParamsSchema.parse(request.params)
    const openid = await publicOpenid(context, request)
    expirePendingOrders(db, now().toISOString())
    let order = getOrderById(db, id)
    assertOrderOwner(order, openid)
    enforceSyncInterval(syncTimestamps, `${openid}:${id}`, now().getTime())
    if (config.paymentMode === 'wechat' && order.status === 'pending') {
      const transaction = await wechat.queryOrder(order.orderNo)
      validateWechatTransaction(config, order, transaction)
      if (transaction.trade_state === 'SUCCESS') {
        const transactionId = requireWechatTransactionId(transaction)
        order = recordPayment(db, {
          eventId: `query:${transactionId}`,
          eventType: 'TRANSACTION.QUERY.SUCCESS',
          orderId: order.id,
          transactionId,
          rawPayload: JSON.stringify(transaction),
          paidAt: wechatPaidAt(transaction.success_time, now().toISOString()),
          now: now().toISOString(),
          allowClosed: true,
        }).order
      } else if (['CLOSED', 'REVOKED', 'PAYERROR'].includes(transaction.trade_state)) {
        order = closeOrder(db, order.id, now().toISOString())
      }
    }
    return { data: { ...safeOrder(order), paymentParams: paymentParamsFor(context, order) } }
  })

  app.post('/api/wechat/pay/notify', async (request, reply) => {
    if (config.paymentMode !== 'wechat') {
      throw new AppError(404, 'NOT_FOUND', '接口不存在')
    }
    if (!Buffer.isBuffer(request.body)) {
      throw new AppError(400, 'WECHAT_NOTIFICATION_INVALID', '微信支付回调必须使用 JSON')
    }
    const rawBody = request.body.toString('utf8')
    const notification = wechat.verifyAndDecryptNotification(rawBody, request.headers)
    if (notification.eventType !== 'TRANSACTION.SUCCESS') {
      void reply.status(200)
      return { code: 'SUCCESS', message: '成功' }
    }
    const order = getOrderByNo(db, notification.transaction.out_trade_no)
    validateWechatTransaction(config, order, notification.transaction)
    if (notification.transaction.trade_state !== 'SUCCESS') {
      throw new AppError(400, 'WECHAT_PAYMENT_INVALID', '微信支付交易状态不是成功')
    }
    const transactionId = requireWechatTransactionId(notification.transaction)
    recordPayment(db, {
      eventId: notification.id,
      eventType: notification.eventType,
      orderId: order.id,
      transactionId,
      rawPayload: rawBody,
      paidAt: wechatPaidAt(notification.transaction.success_time, now().toISOString()),
      now: now().toISOString(),
      allowClosed: true,
    })
    void reply.status(200)
    return { code: 'SUCCESS', message: '成功' }
  })

  app.post('/api/wechat/refund/notify', async (request, reply) => {
    if (config.paymentMode !== 'wechat') {
      throw new AppError(404, 'NOT_FOUND', '接口不存在')
    }
    if (!Buffer.isBuffer(request.body)) {
      throw new AppError(400, 'WECHAT_NOTIFICATION_INVALID', '微信退款回调必须使用 JSON')
    }
    const rawBody = request.body.toString('utf8')
    const notification = wechat.verifyAndDecryptRefundNotification(rawBody, request.headers)
    const result: WechatRefund = {
      ...notification.refund,
      status: notification.refund.refund_status,
    }
    if (notification.eventType !== `REFUND.${result.status}`) {
      throw new AppError(400, 'WECHAT_REFUND_INVALID', '微信退款回调事件与状态不一致')
    }
    const order = getOrderByNo(db, result.out_trade_no)
    const intent = getRefundIntent(db, order.id)
    if (!intent) throw new AppError(404, 'REFUND_NOT_FOUND', '退款申请不存在')
    applyWechatRefund(
      order,
      intent,
      result,
      'wechat:callback',
      notification.id,
      notification.eventType,
      rawBody,
    )
    void reply.status(200)
    return { code: 'SUCCESS', message: '成功' }
  })

  app.post('/api/admin/login', async (request, reply) => {
    const nowMs = now().getTime()
    assertLoginAllowed(loginAttempts, request.ip, nowMs)
    const { password } = loginSchema.parse(request.body)
    let accepted = false
    if (config.adminPasswordHash) {
      accepted = await bcrypt.compare(password, config.adminPasswordHash)
    } else if (!config.isProduction && config.adminPassword) {
      accepted = safePlainTextEqual(password, config.adminPassword)
    }
    if (!accepted) {
      recordLoginFailure(loginAttempts, request.ip, nowMs)
      if ((loginAttempts.get(request.ip)?.failures ?? 0) >= LOGIN_MAX_FAILURES) {
        throw new AppError(429, 'LOGIN_RATE_LIMITED', '登录尝试过多，请15分钟后再试')
      }
      throw new AppError(401, 'INVALID_CREDENTIALS', '管理员密码错误')
    }
    loginAttempts.delete(request.ip)
    const token = app.jwt.sign({ role: 'admin' } satisfies TokenClaims, { expiresIn: '12h' })
    void reply.setCookie(ADMIN_COOKIE, token, {
      httpOnly: true,
      secure: config.isProduction,
      sameSite: 'strict',
      path: '/api/admin',
      maxAge: 12 * 60 * 60,
    })
    return { data: { authenticated: true } }
  })

  app.post('/api/admin/logout', async (_request, reply) => {
    void reply.clearCookie(ADMIN_COOKIE, { path: '/api/admin' })
    return { data: { authenticated: false } }
  })

  app.get('/api/admin/me', async (request) => {
    await requireAdmin(context, request)
    return { data: { authenticated: true } }
  })

  app.get('/api/admin/summary', async (request) => {
    await requireAdmin(context, request)
    const current = now()
    const { period, year, parkingLotId } = summaryQuerySchema.parse(request.query)
    if (parkingLotId) getParkingLot(db, parkingLotId)
    if (year !== undefined && period !== 'year') {
      throw new AppError(400, 'INVALID_SUMMARY_PERIOD', '仅年度概况可选择年份')
    }
    if (year !== undefined && year > shanghaiDateParts(current).year) {
      throw new AppError(400, 'INVALID_SUMMARY_YEAR', '不能查询未来年份')
    }
    expirePendingOrders(db, current.toISOString())
    return { data: getSummary(db, current, period, year, parkingLotId) }
  })

  const adminLot = (lot: ReturnType<typeof getParkingLot>) => ({
    ...lot,
    paymentUrl: paymentUrl(config.publicBaseUrl, lot.id),
  })

  app.get('/api/admin/parking-lots', async (request) => {
    await requireAdmin(context, request)
    return { data: listParkingLots(db, true).map(adminLot) }
  })

  app.post('/api/admin/parking-lots', async (request, reply) => {
    await requireAdmin(context, request)
    const { name, platePrefix } = parkingLotCreateSchema.parse(request.body)
    const lot = createParkingLot(db, name, 'admin', now().toISOString(), platePrefix)
    void reply.status(201)
    return { data: adminLot(lot) }
  })

  app.patch('/api/admin/parking-lots/:id', async (request) => {
    await requireAdmin(context, request)
    const { id } = parkingLotParamsSchema.parse(request.params)
    const changes = parkingLotUpdateSchema.parse(request.body)
    return { data: adminLot(updateParkingLot(db, id, changes, 'admin', now().toISOString())) }
  })

  app.get('/api/admin/prices', async (request) => {
    await requireAdmin(context, request)
    const { parkingLotId } = parkingLotQuerySchema.parse(request.query)
    const { versionId: _versionId, ...prices } = getCurrentPrices(db, parkingLotId)
    return { data: prices }
  })

  app.put('/api/admin/prices', async (request) => {
    await requireAdmin(context, request)
    const { parkingLotId } = parkingLotQuerySchema.parse(request.query)
    const { items } = updatePricesSchema.parse(request.body)
    return { data: replacePrices(db, items, 'admin', now().toISOString(), parkingLotId) }
  })

  app.get('/api/admin/orders/export.csv', async (request, reply) => {
    await requireAdmin(context, request)
    expirePendingOrders(db, now().toISOString())
    const { page: _page, pageSize: _pageSize, ...filters } = parseFilters(request.query)
    if (filters.parkingLotId) getParkingLot(db, filters.parkingLotId)
    const orders = exportOrders(db, filters, MAX_EXPORT_ROWS + 1)
    if (orders.length > MAX_EXPORT_ROWS) {
      throw new AppError(413, 'EXPORT_TOO_LARGE', '导出记录超过20000条，请先缩小日期或其他筛选范围')
    }
    const csv = ordersCsv(orders)
    void reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="parking-orders.csv"')
    return csv
  })

  app.get('/api/admin/orders', async (request) => {
    await requireAdmin(context, request)
    expirePendingOrders(db, now().toISOString())
    const filters = parseFilters(request.query)
    if (filters.parkingLotId) getParkingLot(db, filters.parkingLotId)
    const result = listOrders(db, filters)
    return { data: { ...result, items: result.items.map(safeOrder) } }
  })

  app.get('/api/admin/orders/:id', async (request) => {
    await requireAdmin(context, request)
    expirePendingOrders(db, now().toISOString())
    const { id } = idParamsSchema.parse(request.params)
    return { data: safeOrder(getOrderById(db, id)) }
  })

  app.post('/api/admin/orders/:id/refund', async (request) => {
    await requireAdmin(context, request)
    assertRefundAdminAction(config, request)
    const { id } = idParamsSchema.parse(request.params)
    const { reason } = refundRequestSchema.parse(request.body ?? {})
    if (reason && Buffer.byteLength(reason, 'utf8') > 80) {
      throw new AppError(400, 'REFUND_REASON_TOO_LONG', '退款原因不能超过80字节')
    }
    let order = getOrderById(db, id)
    const existing = getRefundIntent(db, id)
    if (existing && existing.status !== 'requesting') return { data: safeOrder(order) }
    if (!existing && config.paymentMode === 'wechat') {
      if (order.status !== 'paid' || !order.transactionId) {
        throw new AppError(409, 'ORDER_NOT_REFUNDABLE', '仅已支付订单可申请退款')
      }
      const paidAt = order.paidAt ? new Date(order.paidAt).getTime() : NaN
      if (!Number.isFinite(paidAt) || now().getTime() - paidAt > REFUND_WINDOW_MS) {
        throw new AppError(409, 'REFUND_WINDOW_EXPIRED', '支付已超过365天，无法通过微信发起退款')
      }
      const transaction = await wechat.queryOrder(order.orderNo)
      validateWechatTransaction(config, order, transaction)
      if (transaction.trade_state !== 'SUCCESS' || transaction.transaction_id !== order.transactionId) {
        throw new AppError(409, 'WECHAT_PAYMENT_NOT_CONFIRMED', '微信支付状态未确认，不能发起退款')
      }
    }
    if (existing && config.paymentMode === 'wechat') {
      if (
        existing.submittedAt &&
        now().getTime() - new Date(existing.submittedAt).getTime() < REFUND_QUERY_MIN_INTERVAL_MS
      ) return { data: safeOrder(order) }
      enforceSyncInterval(
        refundQueryTimestamps, `refund:${id}`, now().getTime(), REFUND_QUERY_MIN_INTERVAL_MS,
      )
      const queried = await queryWechatRefund(order, existing)
      if (queried) return { data: safeOrder(queried) }
    }
    const { refund } = createRefundIntent(db, id, reason, now().toISOString())
    if (!claimRefundSubmission(db, id, now().toISOString())) {
      return { data: safeOrder(getOrderById(db, id)) }
    }
    order = getOrderById(db, id)
    if (config.paymentMode === 'mock') {
      order = applyRefundResult(db, {
        orderId: id,
        status: 'success',
        wechatRefundId: `MOCK-REFUND-${id}`,
        successAt: now().toISOString(),
        eventType: 'MOCK.REFUND.SUCCESS',
        rawPayload: JSON.stringify({ mock: true, orderId: id }),
        actor: 'mock',
        now: now().toISOString(),
      })
      return { data: safeOrder(order) }
    }
    try {
      const result = await wechat.requestRefund(order, refund)
      order = applyWechatRefund(order, refund, result, 'wechat:request')
    } catch (error) {
      auditRefundError(
        db,
        id,
        'refund.submit.error',
        error instanceof AppError ? error.code : 'UNKNOWN',
        now().toISOString(),
      )
      throw error
    }
    return { data: safeOrder(order) }
  })

  app.post('/api/admin/orders/:id/refund/sync', async (request) => {
    await requireAdmin(context, request)
    assertRefundAdminAction(config, request)
    const { id } = idParamsSchema.parse(request.params)
    const order = getOrderById(db, id)
    const refund = getRefundIntent(db, id)
    if (!refund) throw new AppError(404, 'REFUND_NOT_FOUND', '退款申请不存在')
    if (config.paymentMode !== 'wechat' || refund.status === 'success') {
      return { data: safeOrder(order) }
    }
    enforceSyncInterval(
      refundQueryTimestamps, `refund:${id}`, now().getTime(), REFUND_QUERY_MIN_INTERVAL_MS,
    )
    const queried = await queryWechatRefund(order, refund)
    return { data: safeOrder(queried ?? order) }
  })
}

export async function createApp(options: CreateAppOptions = {}): Promise<FastifyInstance> {
  const config = loadConfig(options.env)
  if (options.databasePath) config.databasePath = options.databasePath
  const defaultLogger: FastifyServerOptions['logger'] = config.isProduction
    ? {
        level: 'info',
        redact: [
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers.set-cookie',
        ],
        serializers: {
          // OAuth code/state 位于查询串，生产日志只保留路径。
          req(request: FastifyRequest) {
            return {
              method: request.method,
              url: request.url.split('?', 1)[0],
              hostname: request.hostname,
              remoteAddress: request.ip,
              remotePort: request.socket.remotePort,
            }
          },
        },
      }
    : false
  const app = Fastify({
    logger: options.logger ?? defaultLogger,
    // 部署约定只有本机 Caddy 反代，信任环回地址后才能按真实客户端 IP 限速。
    trustProxy: '127.0.0.1',
  })
  const db = openDatabase(config)
  const context: AppContext = {
    app,
    config,
    db,
    wechat: new WechatPayClient(config, options.fetch),
    now: options.now ?? (() => new Date()),
    refundPollIntervalMs: options.refundPollIntervalMs ?? 60_000,
  }

  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (request, body, done) => {
      if (
        request.url.startsWith('/api/wechat/pay/notify') ||
        request.url.startsWith('/api/wechat/refund/notify')
      ) {
        done(null, body)
        return
      }
      try {
        done(null, JSON.parse(body.toString('utf8')) as unknown)
      } catch (error) {
        done(new AppError(400, 'INVALID_JSON', 'JSON 请求内容格式不正确'))
      }
    },
  )
  await app.register(cookie)
  await app.register(jwt, { secret: config.jwtSecret })
  app.setErrorHandler(sendError)
  app.addHook('onClose', async () => {
    db.close()
  })
  // Fastify 逆序执行同一实例的 onClose 钩子：先等待退款查单停止，再关闭数据库。
  await registerRoutes(context)

  const staticRoot = resolve(process.cwd(), 'dist', 'public')
  const hasStaticBuild = existsSync(resolve(staticRoot, 'index.html'))
  const serveStatic = options.serveStatic ?? hasStaticBuild
  if (serveStatic && hasStaticBuild) {
    await app.register(fastifyStatic, { root: staticRoot, prefix: '/' })
  }
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api/')) {
      void reply.status(404)
      return { error: { code: 'NOT_FOUND', message: '接口不存在' } }
    }
    if (serveStatic && hasStaticBuild) {
      return reply.sendFile('index.html')
    }
    void reply.status(404)
    return { error: { code: 'NOT_FOUND', message: '页面不存在' } }
  })

  return app
}
