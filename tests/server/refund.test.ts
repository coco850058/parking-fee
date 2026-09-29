import { createCipheriv, createSign, generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { loadConfig } from '../../src/server/config.js'
import { getCurrentPrices, insertOrder, openDatabase, recordPayment } from '../../src/server/database.js'

const apiV3Key = '12345678901234567890123456789012'
const merchantKeys = generateKeyPairSync('rsa', { modulusLength: 2048 })
const platformKeys = generateKeyPairSync('rsa', { modulusLength: 2048 })
const orderId = '40296c77-4bc8-4f74-a2ac-a04a214979e9'
const orderNo = 'PF20260928120000ABCDEF1234'
const transactionId = '42000000000012345678901234567890'
const mchId = '1900000001'

const env = {
  NODE_ENV: 'test',
  PAYMENT_MODE: 'wechat',
  JWT_SECRET: 'test-secret-with-more-than-thirty-two-characters',
  ADMIN_PASSWORD: 'refund-test-admin-password',
  PUBLIC_BASE_URL: 'https://pay.example.com',
  WECHAT_APP_ID: 'wx-test-app',
  WECHAT_MCH_ID: mchId,
  WECHAT_MCH_SERIAL_NO: 'MERCHANT-SERIAL',
  WECHAT_MCH_PRIVATE_KEY: merchantKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  WECHAT_API_V3_KEY: apiV3Key,
  WECHAT_PLATFORM_PUBLIC_KEY: platformKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  WECHAT_PLATFORM_PUBLIC_KEY_ID: 'PUB_KEY_ID_TEST',
}

function signedHeaders(rawBody: string): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000))
  const nonce = 'refund-test-nonce'
  const signer = createSign('RSA-SHA256')
  signer.update(`${timestamp}\n${nonce}\n${rawBody}\n`)
  signer.end()
  return {
    'wechatpay-timestamp': timestamp,
    'wechatpay-nonce': nonce,
    'wechatpay-signature': signer.sign(platformKeys.privateKey, 'base64'),
    'wechatpay-serial': 'PUB_KEY_ID_TEST',
  }
}

function signedResponse(body: object, status = 200): Response {
  const rawBody = JSON.stringify(body)
  return new Response(rawBody, {
    status,
    headers: { ...signedHeaders(rawBody), 'content-type': 'application/json' },
  })
}

function refundResult(status: string, outRefundNo: string): object {
  return {
    refund_id: '50000000000000000000000000000001',
    out_refund_no: outRefundNo,
    out_trade_no: orderNo,
    transaction_id: transactionId,
    status,
    amount: { total: 100, refund: 100, currency: 'CNY' },
    ...(status === 'SUCCESS' ? { success_time: new Date().toISOString() } : {}),
  }
}

function signedCallback(
  outRefundNo: string,
  overrides: Record<string, unknown> = {},
  eventId = 'EV-REFUND-001',
): { body: string; headers: Record<string, string> } {
  const resource = {
    mchid: mchId,
    refund_status: 'SUCCESS',
    ...refundResult('SUCCESS', outRefundNo),
    ...overrides,
  }
  const nonce = '0123456789ab'
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(apiV3Key), Buffer.from(nonce))
  cipher.setAAD(Buffer.from(''))
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(resource), 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ])
  const body = JSON.stringify({
    id: eventId,
    event_type: 'REFUND.SUCCESS',
    resource: {
      algorithm: 'AEAD_AES_256_GCM',
      original_type: 'refund',
      ciphertext: encrypted.toString('base64'),
      nonce,
      associated_data: '',
    },
  })
  return { body, headers: { ...signedHeaders(body), 'content-type': 'application/json' } }
}

function signedLatePaymentCallback(): { body: string; headers: Record<string, string> } {
  const transaction = {
    appid: env.WECHAT_APP_ID,
    mchid: mchId,
    out_trade_no: orderNo,
    transaction_id: transactionId,
    trade_state: 'SUCCESS',
    amount: { total: 100, currency: 'CNY' },
  }
  const nonce = '0123456789ab'
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(apiV3Key), Buffer.from(nonce))
  cipher.setAAD(Buffer.from(''))
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(transaction), 'utf8'), cipher.final(), cipher.getAuthTag(),
  ])
  const body = JSON.stringify({
    id: 'EV-LATE-PAYMENT-001',
    event_type: 'TRANSACTION.SUCCESS',
    resource: { algorithm: 'AEAD_AES_256_GCM', ciphertext: encrypted.toString('base64'), nonce },
  })
  return { body, headers: { ...signedHeaders(body), 'content-type': 'application/json' } }
}

function json<T>(response: { json(): unknown }): T { return response.json() as T }

describe('微信退款与个人缴费记录', () => {
  let app: FastifyInstance
  let directory: string
  let clock: Date
  let postBodies: Array<Record<string, unknown>>
  let queryStatus: 'PROCESSING' | 'SUCCESS' | 'CLOSED' | 'ABNORMAL' | 'MISSING'
  let paymentState: 'SUCCESS' | 'NOTPAY'
  let failNextPost: boolean
  let fetchImpl: typeof fetch

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'park-fee-refund-'))
    clock = new Date('2026-09-28T12:00:00.000Z')
    postBodies = []
    queryStatus = 'PROCESSING'
    paymentState = 'SUCCESS'
    failNextPost = false
    const databasePath = join(directory, 'parking.db')
    const db = openDatabase(loadConfig({ ...env, DATABASE_PATH: databasePath }))
    const prices = getCurrentPrices(db)
    insertOrder(db, {
      id: orderId,
      orderNo,
      clientRequestId: randomUUID(),
      openid: 'owner-openid',
      customerType: 'resident',
      address: '测试小区1栋',
      plateNumber: '粤B12345',
      durationMonths: 1,
      amount: 100,
      priceVersion: prices.version,
      priceVersionId: prices.versionId,
      paymentMode: 'wechat',
      now: clock.toISOString(),
      expiresAt: new Date(clock.getTime() + 7_200_000).toISOString(),
    })
    recordPayment(db, {
      eventId: 'PAY-001',
      eventType: 'TRANSACTION.SUCCESS',
      orderId,
      transactionId,
      rawPayload: '{}',
      paidAt: clock.toISOString(),
      now: clock.toISOString(),
    })
    db.close()

    fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      if (url.endsWith('/v3/refund/domestic/refunds') && init?.method === 'POST') {
        const payload = JSON.parse(String(init.body)) as Record<string, unknown>
        postBodies.push(payload)
        expect(new Headers(init.headers).get('Wechatpay-Serial')).toBe('PUB_KEY_ID_TEST')
        if (failNextPost) {
          failNextPost = false
          throw new Error('simulated network uncertainty')
        }
        return signedResponse(refundResult('PROCESSING', String(payload.out_refund_no)))
      }
      if (url.includes('/v3/refund/domestic/refunds/') && init?.method === 'GET') {
        if (queryStatus === 'MISSING') {
          return signedResponse({ code: 'RESOURCE_NOT_EXISTS', message: '退款单不存在' }, 404)
        }
        return signedResponse(refundResult(queryStatus, decodeURIComponent(url.split('/').at(-1)!)))
      }
      if (url.includes('/v3/pay/transactions/out-trade-no/') && init?.method === 'GET') {
        return signedResponse({
          appid: env.WECHAT_APP_ID,
          mchid: mchId,
          out_trade_no: orderNo,
          transaction_id: transactionId,
          trade_state: paymentState,
          amount: { total: 100, currency: 'CNY' },
        })
      }
      throw new Error(`Unexpected fake request: ${url}`)
    }) as typeof fetch
    app = await createApp({ env, databasePath, serveStatic: false, fetch: fetchImpl, now: () => clock })
  })

  afterEach(async () => {
    await app.close()
    rmSync(directory, { recursive: true, force: true })
  })

  async function adminCookie(): Promise<string> {
    const login = await app.inject({
      method: 'POST', url: '/api/admin/login', payload: { password: env.ADMIN_PASSWORD },
    })
    expect(login.statusCode).toBe(200)
    return String(login.headers['set-cookie']).split(';', 1)[0]
  }

  it('个人历史按 OpenID 隔离，已支付订单可查询详情', async () => {
    const denied = await app.inject({ method: 'GET', url: '/api/public/orders/history' })
    expect(denied.statusCode).toBe(401)
    const owner = app.jwt.sign({ role: 'public', openid: 'owner-openid' })
    const other = app.jwt.sign({ role: 'public', openid: 'other-openid' })
    const ownHistory = await app.inject({
      method: 'GET', url: '/api/public/orders/history?page=1&pageSize=10',
      headers: { cookie: `park_session=${owner}` },
    })
    expect(json<{ data: { total: number; items: Array<{ id: string; openid?: string }> } }>(ownHistory).data)
      .toMatchObject({ total: 1, items: [{ id: orderId }] })
    expect(json<{ data: { items: Array<{ openid?: string }> } }>(ownHistory).data.items[0])
      .not.toHaveProperty('openid')
    const otherHistory = await app.inject({
      method: 'GET', url: '/api/public/orders/history',
      headers: { cookie: `park_session=${other}` },
    })
    expect(json<{ data: { total: number } }>(otherHistory).data.total).toBe(0)
    const otherDetail = await app.inject({
      method: 'GET', url: `/api/public/orders/${orderId}`,
      headers: { cookie: `park_session=${other}` },
    })
    expect(otherDetail.statusCode).toBe(404)
  })

  it('退款申请受理时订单仍已支付，金额错的回调被拒，合法回调才标为已退款', async () => {
    const cookie = await adminCookie()
    const headers = { cookie, 'x-parkfee-admin-action': 'refund' }
    const first = await app.inject({
      method: 'POST', url: `/api/admin/orders/${orderId}/refund`,
      headers, payload: { reason: '重复缴费' },
    })
    expect(first.statusCode).toBe(200)
    expect(json<{ data: { status: string; refund: { status: string; amount: number } } }>(first).data)
      .toMatchObject({ status: 'paid', refund: { status: 'processing', amount: 100 } })
    expect(postBodies).toHaveLength(1)
    expect(postBodies[0]).toMatchObject({
      transaction_id: transactionId,
      reason: '重复缴费',
      notify_url: 'https://pay.example.com/api/wechat/refund/notify',
      amount: { total: 100, refund: 100, currency: 'CNY' },
    })
    const outRefundNo = String(postBodies[0]?.out_refund_no)

    const replay = await app.inject({ method: 'POST', url: `/api/admin/orders/${orderId}/refund`, headers })
    expect(replay.statusCode).toBe(200)
    expect(postBodies).toHaveLength(1)

    const wrongAmount = signedCallback(outRefundNo, { amount: { total: 100, refund: 1 } })
    const rejected = await app.inject({
      method: 'POST', url: '/api/wechat/refund/notify',
      headers: wrongAmount.headers, payload: wrongAmount.body,
    })
    expect(rejected.statusCode).toBe(400)
    const stillPaid = await app.inject({ method: 'GET', url: `/api/admin/orders/${orderId}`, headers: { cookie } })
    expect(json<{ data: { status: string } }>(stillPaid).data.status).toBe('paid')

    const callback = signedCallback(outRefundNo)
    const success = await app.inject({
      method: 'POST', url: '/api/wechat/refund/notify',
      headers: callback.headers, payload: callback.body,
    })
    expect(success.statusCode).toBe(200)
    const duplicate = await app.inject({
      method: 'POST', url: '/api/wechat/refund/notify',
      headers: callback.headers, payload: callback.body,
    })
    expect(duplicate.statusCode).toBe(200)
    const refunded = await app.inject({ method: 'GET', url: `/api/admin/orders/${orderId}`, headers: { cookie } })
    expect(json<{ data: { status: string; refund: { status: string; successAt: string } } }>(refunded).data)
      .toMatchObject({ status: 'refunded', refund: { status: 'success' } })

    const latePayment = signedLatePaymentCallback()
    const late = await app.inject({
      method: 'POST', url: '/api/wechat/pay/notify',
      headers: latePayment.headers, payload: latePayment.body,
    })
    expect(late.statusCode).toBe(200)
    const afterLate = await app.inject({ method: 'GET', url: `/api/admin/orders/${orderId}`, headers: { cookie } })
    expect(json<{ data: { status: string } }>(afterLate).data.status).toBe('refunded')
  })

  it('首次真实退款前须确认微信原交易仍是 SUCCESS', async () => {
    const cookie = await adminCookie()
    paymentState = 'NOTPAY'
    const denied = await app.inject({
      method: 'POST', url: `/api/admin/orders/${orderId}/refund`,
      headers: { cookie, 'x-parkfee-admin-action': 'refund' },
    })
    expect(denied.statusCode).toBe(409)
    expect(postBodies).toHaveLength(0)
    const detail = await app.inject({ method: 'GET', url: `/api/admin/orders/${orderId}`, headers: { cookie } })
    expect(json<{ data: { refund: unknown } }>(detail).data.refund).toBeNull()
  })

  it('超过365天的交易不能发起微信退款', async () => {
    const cookie = await adminCookie()
    clock = new Date(clock.getTime() + 366 * 24 * 60 * 60 * 1000)
    const denied = await app.inject({
      method: 'POST', url: `/api/admin/orders/${orderId}/refund`,
      headers: { cookie, 'x-parkfee-admin-action': 'refund' },
    })
    expect(denied.statusCode).toBe(409)
    expect(json<{ error: { code: string } }>(denied).error.code).toBe('REFUND_WINDOW_EXPIRED')
    expect(postBodies).toHaveLength(0)
  })

  it('网络结果不确定时固定原退款单号；一分钟内不重复提交，查单确认不存在后才允许重试', async () => {
    const cookie = await adminCookie()
    const headers = { cookie, 'x-parkfee-admin-action': 'refund' }
    failNextPost = true
    const first = await app.inject({ method: 'POST', url: `/api/admin/orders/${orderId}/refund`, headers })
    expect(first.statusCode).toBe(502)
    const firstNo = String(postBodies[0]?.out_refund_no)
    queryStatus = 'MISSING'
    const immediate = await app.inject({ method: 'POST', url: `/api/admin/orders/${orderId}/refund`, headers })
    expect(immediate.statusCode).toBe(200)
    expect(json<{ data: { status: string; refund: { status: string } } }>(immediate).data)
      .toMatchObject({ status: 'paid', refund: { status: 'requesting' } })
    expect(postBodies).toHaveLength(1)

    clock = new Date(clock.getTime() + 61_000)
    const retry = await app.inject({ method: 'POST', url: `/api/admin/orders/${orderId}/refund`, headers })
    expect(retry.statusCode).toBe(200)
    expect(postBodies).toHaveLength(2)
    expect(postBodies[1]?.out_refund_no).toBe(firstNo)
    expect(postBodies[1]).toEqual(postBodies[0])
    const status = json<{ data: { status: string; refund: { status: string } } }>(retry).data
    expect(status).toMatchObject({ status: 'paid', refund: { status: 'processing' } })

    queryStatus = 'SUCCESS'
    clock = new Date(clock.getTime() + 6_000)
    const sync = await app.inject({ method: 'POST', url: `/api/admin/orders/${orderId}/refund/sync`, headers })
    expect(sync.statusCode).toBe(200)
    expect(json<{ data: { status: string; refund: { status: string } } }>(sync).data)
      .toMatchObject({ status: 'refunded', refund: { status: 'success' } })
  })

  it('退款异常不能被旧的处理中查单降级，只有明确成功才变更原订单', async () => {
    const cookie = await adminCookie()
    const headers = { cookie, 'x-parkfee-admin-action': 'refund' }
    await app.inject({ method: 'POST', url: `/api/admin/orders/${orderId}/refund`, headers })
    queryStatus = 'ABNORMAL'
    const abnormal = await app.inject({ method: 'POST', url: `/api/admin/orders/${orderId}/refund/sync`, headers })
    expect(json<{ data: { status: string; refund: { status: string } } }>(abnormal).data)
      .toMatchObject({ status: 'paid', refund: { status: 'abnormal' } })
    queryStatus = 'PROCESSING'
    clock = new Date(clock.getTime() + 6_000)
    const stale = await app.inject({ method: 'POST', url: `/api/admin/orders/${orderId}/refund/sync`, headers })
    expect(json<{ data: { status: string; refund: { status: string } } }>(stale).data)
      .toMatchObject({ status: 'paid', refund: { status: 'abnormal' } })
    queryStatus = 'SUCCESS'
    clock = new Date(clock.getTime() + 6_000)
    const resolved = await app.inject({ method: 'POST', url: `/api/admin/orders/${orderId}/refund/sync`, headers })
    expect(json<{ data: { status: string; refund: { status: string } } }>(resolved).data)
      .toMatchObject({ status: 'refunded', refund: { status: 'success' } })
  })

  it('退款回调丢失时后台限量只读查单可自动确认成功，不再次提交退款', async () => {
    const cookie = await adminCookie()
    const headers = { cookie, 'x-parkfee-admin-action': 'refund' }
    const requested = await app.inject({ method: 'POST', url: `/api/admin/orders/${orderId}/refund`, headers })
    expect(requested.statusCode).toBe(200)
    expect(postBodies).toHaveLength(1)
    await app.close()
    clock = new Date(clock.getTime() + 61_000)
    queryStatus = 'SUCCESS'
    app = await createApp({
      env,
      databasePath: join(directory, 'parking.db'),
      serveStatic: false,
      fetch: fetchImpl,
      now: () => clock,
      refundPollIntervalMs: 20,
    })
    await new Promise((resolve) => setTimeout(resolve, 120))
    const currentCookie = await adminCookie()
    const detail = await app.inject({
      method: 'GET', url: `/api/admin/orders/${orderId}`,
      headers: { cookie: currentCookie },
    })
    expect(json<{ data: { status: string; refund: { status: string } } }>(detail).data)
      .toMatchObject({ status: 'refunded', refund: { status: 'success' } })
    expect(postBodies).toHaveLength(1)
  })
})
