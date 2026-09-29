import { generateKeyPairSync, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../../src/server/app.js'

const testEnv = {
  NODE_ENV: 'test',
  PAYMENT_MODE: 'mock',
  JWT_SECRET: 'test-secret-with-more-than-thirty-two-characters',
  ADMIN_PASSWORD: 'correct horse battery staple',
}

function body<T>(response: { json(): unknown }): T {
  return response.json() as T
}

function cookieFrom(response: { headers: Record<string, string | string[] | undefined> }): string {
  const header = response.headers['set-cookie']
  const value = Array.isArray(header) ? header[0] : header
  if (!value) throw new Error('响应未设置 Cookie')
  return value.split(';', 1)[0]
}

async function adminCookie(app: FastifyInstance): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/admin/login',
    payload: { password: testEnv.ADMIN_PASSWORD },
  })
  expect(response.statusCode).toBe(200)
  return cookieFrom(response)
}

function orderPayload(
  overrides: Partial<{
    clientRequestId: string
    priceVersion: number
    expectedAmount: number
    customerType: 'merchant' | 'resident'
    address: string
    plateNumber: string
    durationMonths: 1 | 3 | 6 | 12
  }> = {},
) {
  return {
    clientRequestId: randomUUID(),
    priceVersion: 1,
    expectedAmount: 10_000,
    customerType: 'merchant' as const,
    address: '一号楼101室',
    plateNumber: '粤B12345',
    durationMonths: 1 as const,
    ...overrides,
  }
}

describe('停车缴费后端', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    app = await createApp({ env: testEnv, databasePath: ':memory:', serveStatic: false })
  })

  afterEach(async () => {
    await app.close()
  })

  it('初始化完整的演示价格，并由服务端计算订单金额和归一化车牌', async () => {
    const priceResponse = await app.inject({ method: 'GET', url: '/api/public/prices' })
    expect(priceResponse.statusCode).toBe(200)
    const prices = body<{
      data: { version: number; enabled: boolean; items: Array<{ amount: number }> }
    }>(priceResponse).data
    expect(prices.version).toBe(1)
    expect(prices.enabled).toBe(true)
    expect(prices.items).toHaveLength(8)

    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/public/orders',
      payload: orderPayload({ plateNumber: '粤 b·12345' }),
    })
    expect(createResponse.statusCode).toBe(201)
    const order = body<{
      data: { id: string; amount: number; plateNumber: string; priceVersion: number; status: string }
    }>(createResponse).data
    expect(order.amount).toBe(10_000)
    expect(order.plateNumber).toBe('粤B12345')
    expect(order.priceVersion).toBe(1)
    expect(order.status).toBe('pending')
  })

  it('创建订单接受新能源车牌并拒绝非标准的 8 位车牌', async () => {
    for (const plateNumber of ['新AD12345', '新A12345D']) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/public/orders',
        payload: orderPayload({ plateNumber }),
      })
      expect(response.statusCode).toBe(201)
      expect(body<{ data: { plateNumber: string } }>(response).data.plateNumber).toBe(plateNumber)
    }

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/public/orders',
      payload: orderPayload({ plateNumber: '新A123456' }),
    })
    expect(invalid.statusCode).toBe(400)
  })

  it('生产环境首次初始化为零价格并禁止创建支付订单', async () => {
    const productionApp = await createApp({
      env: {
        NODE_ENV: 'production',
        PAYMENT_MODE: 'mock',
        JWT_SECRET: 'production-secret-with-more-than-32-characters',
        ADMIN_PASSWORD_HASH: '$2b$12$not-used-in-this-test-but-required',
      },
      databasePath: ':memory:',
      logger: false,
      serveStatic: false,
    })
    try {
      const prices = await productionApp.inject({ method: 'GET', url: '/api/public/prices' })
      expect(body<{ data: { enabled: boolean; items: Array<{ amount: number }> } }>(prices).data).toMatchObject({
        enabled: false,
      })
      expect(
        body<{ data: { items: Array<{ amount: number }> } }>(prices).data.items.every(
          (item) => item.amount === 0,
        ),
      ).toBe(true)

      const order = await productionApp.inject({
        method: 'POST',
        url: '/api/public/orders',
        payload: orderPayload({
          expectedAmount: 0,
          customerType: 'resident',
          address: '二号楼202室',
          plateNumber: '沪A12345',
          durationMonths: 3,
        }),
      })
      expect(order.statusCode).toBe(409)
      expect(body<{ error: { code: string } }>(order).error.code).toBe('PAYMENT_DISABLED')
    } finally {
      await productionApp.close()
    }
  })

  it('管理员需要登录，改价生成新版本且旧订单保留金额快照', async () => {
    const denied = await app.inject({ method: 'GET', url: '/api/admin/summary' })
    expect(denied.statusCode).toBe(401)

    const badLogin = await app.inject({
      method: 'POST',
      url: '/api/admin/login',
      payload: { password: 'wrong' },
    })
    expect(badLogin.statusCode).toBe(401)
    const cookie = await adminCookie(app)

    const original = await app.inject({
      method: 'POST',
      url: '/api/public/orders',
      payload: orderPayload({
        expectedAmount: 22_000,
        customerType: 'resident',
        address: '三号楼303室',
        plateNumber: '沪A12345',
        durationMonths: 3,
      }),
    })
    const originalOrder = body<{ data: { id: string; amount: number } }>(original).data
    expect(originalOrder.amount).toBe(22_000)

    const items = (['merchant', 'resident'] as const).flatMap((customerType) =>
      ([1, 3, 6, 12] as const).map((durationMonths) => ({
        customerType,
        durationMonths,
        amount: customerType === 'resident' && durationMonths === 3 ? 25_500 : 12_345,
      })),
    )
    const update = await app.inject({
      method: 'PUT',
      url: '/api/admin/prices',
      headers: { cookie },
      payload: { items },
    })
    expect(update.statusCode).toBe(200)
    expect(body<{ data: { version: number } }>(update).data.version).toBe(2)

    const fetchedOriginal = await app.inject({
      method: 'GET',
      url: `/api/public/orders/${originalOrder.id}`,
    })
    expect(body<{ data: { amount: number; priceVersion: number } }>(fetchedOriginal).data).toMatchObject({
      amount: 22_000,
      priceVersion: 1,
    })

    const replacement = await app.inject({
      method: 'POST',
      url: '/api/public/orders',
      payload: orderPayload({
        priceVersion: 2,
        expectedAmount: 25_500,
        customerType: 'resident',
        address: '三号楼303室',
        plateNumber: '沪A12345',
        durationMonths: 3,
      }),
    })
    expect(body<{ data: { amount: number; priceVersion: number } }>(replacement).data).toMatchObject({
      amount: 25_500,
      priceVersion: 2,
    })
  })

  it('模拟支付可重复调用且管理端可汇总、组合筛选及导出', async () => {
    const cookie = await adminCookie(app)
    const created = await app.inject({
      method: 'POST',
      url: '/api/public/orders',
      payload: orderPayload({
        expectedAmount: 42_000,
        customerType: 'resident',
        address: '幸福小区6栋',
        plateNumber: '苏A88888',
        durationMonths: 6,
      }),
    })
    const order = body<{ data: { id: string; amount: number } }>(created).data

    const first = await app.inject({ method: 'POST', url: `/api/public/orders/${order.id}/mock-pay` })
    const second = await app.inject({ method: 'POST', url: `/api/public/orders/${order.id}/mock-pay` })
    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(200)
    expect(body<{ data: { status: string } }>(second).data.status).toBe('paid')

    const summary = await app.inject({
      method: 'GET',
      url: '/api/admin/summary',
      headers: { cookie },
    })
    expect(body<{ data: { all: { count: number; amount: number }; pendingCount: number } }>(summary).data).toMatchObject({
      all: { count: 1, amount: order.amount },
      pendingCount: 0,
    })

    const filtered = await app.inject({
      method: 'GET',
      url: '/api/admin/orders?status=paid&customerType=resident&durationMonths=6&keyword=苏A88888&page=1&pageSize=10',
      headers: { cookie },
    })
    const list = body<{ data: { total: number; items: Array<{ id: string }> } }>(filtered).data
    expect(list.total).toBe(1)
    expect(list.items[0]?.id).toBe(order.id)

    const exported = await app.inject({
      method: 'GET',
      url: '/api/admin/orders/export.csv?status=paid&keyword=幸福小区',
      headers: { cookie },
    })
    expect(exported.statusCode).toBe(200)
    expect(exported.headers['content-type']).toContain('text/csv')
    expect(exported.body).toContain('苏A88888')
    expect(exported.body).toContain('幸福小区6栋')
  })

  it('个人历史仅展示真正缴费记录，管理员全额退款需认证和确认头且重复操作不重复退款', async () => {
    const cookie = await adminCookie(app)
    const created = await app.inject({
      method: 'POST',
      url: '/api/public/orders',
      payload: orderPayload(),
    })
    const id = body<{ data: { id: string } }>(created).data.id
    await app.inject({ method: 'POST', url: '/api/public/orders', payload: orderPayload() })

    const before = await app.inject({ method: 'GET', url: '/api/public/orders/history?page=1&pageSize=1' })
    expect(before.statusCode).toBe(200)
    expect(body<{ data: { total: number } }>(before).data.total).toBe(0)

    const denied = await app.inject({ method: 'POST', url: `/api/admin/orders/${id}/refund` })
    expect(denied.statusCode).toBe(401)
    const missingHeader = await app.inject({
      method: 'POST', url: `/api/admin/orders/${id}/refund`, headers: { cookie },
    })
    expect(missingHeader.statusCode).toBe(403)
    const pending = await app.inject({
      method: 'POST', url: `/api/admin/orders/${id}/refund`,
      headers: { cookie, 'x-parkfee-admin-action': 'refund' },
    })
    expect(pending.statusCode).toBe(409)

    await app.inject({ method: 'POST', url: `/api/public/orders/${id}/mock-pay` })
    const paid = await app.inject({ method: 'GET', url: '/api/public/orders/history?page=1&pageSize=1' })
    expect(body<{ data: { total: number; items: Array<{ id: string; refund: unknown; openid?: string }> } }>(paid).data)
      .toMatchObject({ total: 1, items: [{ id, refund: null }] })
    expect(body<{ data: { items: Array<{ openid?: string }> } }>(paid).data.items[0]).not.toHaveProperty('openid')

    const refunded = await app.inject({
      method: 'POST', url: `/api/admin/orders/${id}/refund`,
      headers: { cookie, 'x-parkfee-admin-action': 'refund' },
      payload: { reason: '重复缴费' },
    })
    expect(refunded.statusCode).toBe(200)
    expect(body<{ data: { status: string; refund: { status: string; amount: number; successAt: string } } }>(refunded).data)
      .toMatchObject({ status: 'refunded', refund: { status: 'success', amount: 10_000 } })

    const replay = await app.inject({
      method: 'POST', url: `/api/admin/orders/${id}/refund`,
      headers: { cookie, 'x-parkfee-admin-action': 'refund' },
    })
    expect(replay.statusCode).toBe(200)
    expect(body<{ data: { refund: { status: string } } }>(replay).data.refund.status).toBe('success')

    const history = await app.inject({ method: 'GET', url: '/api/public/orders/history' })
    expect(body<{ data: { total: number; items: Array<{ status: string }> } }>(history).data)
      .toMatchObject({ total: 1, items: [{ status: 'refunded' }] })
    const summary = await app.inject({ method: 'GET', url: '/api/admin/summary', headers: { cookie } })
    expect(body<{ data: { all: { count: number; amount: number } } }>(summary).data.all)
      .toEqual({ count: 0, amount: 0 })
  })

  it('同一用户的 clientRequestId 幂等重放原订单，并拒绝冲突载荷', async () => {
    const clientRequestId = randomUUID()
    const payload = orderPayload({ clientRequestId })
    const first = await app.inject({ method: 'POST', url: '/api/public/orders', payload })
    const replay = await app.inject({ method: 'POST', url: '/api/public/orders', payload })

    expect(first.statusCode).toBe(201)
    expect(replay.statusCode).toBe(200)
    const firstOrder = body<{ data: { id: string; orderNo: string; openid?: string } }>(first).data
    const replayedOrder = body<{ data: { id: string; orderNo: string; openid?: string } }>(replay).data
    expect(replayedOrder.id).toBe(firstOrder.id)
    expect(replayedOrder.orderNo).toBe(firstOrder.orderNo)
    expect(firstOrder).not.toHaveProperty('openid')
    expect(firstOrder).not.toHaveProperty('clientRequestId')
    expect(replayedOrder).not.toHaveProperty('openid')
    expect(replayedOrder).not.toHaveProperty('clientRequestId')

    const conflict = await app.inject({
      method: 'POST',
      url: '/api/public/orders',
      payload: { ...payload, address: '另一处地址' },
    })
    expect(conflict.statusCode).toBe(409)
    expect(body<{ error: { code: string } }>(conflict).error.code).toBe('IDEMPOTENCY_CONFLICT')

    const cookie = await adminCookie(app)
    const orders = await app.inject({
      method: 'GET',
      url: '/api/admin/orders',
      headers: { cookie },
    })
    const adminList = body<{
      data: { total: number; items: Array<{ openid?: string; clientRequestId?: string }> }
    }>(orders).data
    expect(adminList.total).toBe(1)
    expect(adminList.items[0]).not.toHaveProperty('openid')
    expect(adminList.items[0]).not.toHaveProperty('clientRequestId')
  })

  it('价格版本或预期金额过期时拒绝建单且不产生脏订单', async () => {
    const cookie = await adminCookie(app)
    const items = (['merchant', 'resident'] as const).flatMap((customerType) =>
      ([1, 3, 6, 12] as const).map((durationMonths) => ({
        customerType,
        durationMonths,
        amount: 12_345,
      })),
    )
    await app.inject({
      method: 'PUT',
      url: '/api/admin/prices',
      headers: { cookie },
      payload: { items },
    })

    const staleVersion = await app.inject({
      method: 'POST',
      url: '/api/public/orders',
      payload: orderPayload(),
    })
    expect(staleVersion.statusCode).toBe(409)
    expect(body<{ error: { code: string } }>(staleVersion).error.code).toBe('PRICE_CHANGED')

    const staleAmount = await app.inject({
      method: 'POST',
      url: '/api/public/orders',
      payload: orderPayload({ priceVersion: 2, expectedAmount: 1 }),
    })
    expect(staleAmount.statusCode).toBe(409)
    expect(body<{ error: { code: string } }>(staleAmount).error.code).toBe('PRICE_CHANGED')

    const orders = await app.inject({
      method: 'GET',
      url: '/api/admin/orders',
      headers: { cookie },
    })
    expect(body<{ data: { total: number } }>(orders).data.total).toBe(0)
  })

  it('订单两小时后自动关闭，且过期订单不能再模拟支付', async () => {
    let clock = new Date('2026-09-22T00:00:00.000Z')
    const timedApp = await createApp({
      env: testEnv,
      databasePath: ':memory:',
      serveStatic: false,
      now: () => clock,
    })
    try {
      const created = await timedApp.inject({
        method: 'POST',
        url: '/api/public/orders',
        payload: orderPayload(),
      })
      const order = body<{ data: { id: string; expiresAt: string } }>(created).data
      expect(order.expiresAt).toBe('2026-09-22T02:00:00.000Z')

      clock = new Date('2026-09-22T02:00:00.001Z')
      const fetched = await timedApp.inject({
        method: 'GET',
        url: `/api/public/orders/${order.id}`,
      })
      expect(body<{ data: { status: string; paymentParams: unknown } }>(fetched).data).toMatchObject({
        status: 'closed',
        paymentParams: null,
      })

      const pay = await timedApp.inject({
        method: 'POST',
        url: `/api/public/orders/${order.id}/mock-pay`,
      })
      expect(pay.statusCode).toBe(409)
      expect(body<{ error: { code: string } }>(pay).error.code).toBe('ORDER_NOT_PAYABLE')

      const cookie = await adminCookie(timedApp)
      const summary = await timedApp.inject({
        method: 'GET',
        url: '/api/admin/summary',
        headers: { cookie },
      })
      expect(body<{ data: { pendingCount: number } }>(summary).data.pendingCount).toBe(0)
    } finally {
      await timedApp.close()
    }
  })

  it('创建订单按用户和来源限频，订单同步也有最小间隔', async () => {
    let lastId = ''
    for (let index = 0; index < 10; index += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/public/orders',
        remoteAddress: '203.0.113.20',
        payload: orderPayload(),
      })
      expect(response.statusCode).toBe(201)
      lastId = body<{ data: { id: string } }>(response).data.id
    }
    const limited = await app.inject({
      method: 'POST',
      url: '/api/public/orders',
      remoteAddress: '203.0.113.20',
      payload: orderPayload(),
    })
    expect(limited.statusCode).toBe(429)
    expect(body<{ error: { code: string } }>(limited).error.code).toBe('ORDER_CREATE_RATE_LIMITED')

    const firstSync = await app.inject({
      method: 'POST',
      url: `/api/public/orders/${lastId}/sync`,
      remoteAddress: '203.0.113.20',
    })
    const secondSync = await app.inject({
      method: 'POST',
      url: `/api/public/orders/${lastId}/sync`,
      remoteAddress: '203.0.113.20',
    })
    expect(firstSync.statusCode).toBe(200)
    expect(secondSync.statusCode).toBe(429)
    expect(body<{ error: { code: string } }>(secondSync).error.code).toBe('ORDER_SYNC_RATE_LIMITED')
  })

  it('微信预下单失败时立即关闭本地订单', async () => {
    const merchantKeys = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const wechatApp = await createApp({
      env: {
        ...testEnv,
        PAYMENT_MODE: 'wechat',
        WECHAT_APP_ID: 'wx-test-app',
        WECHAT_MCH_ID: '1900000001',
        WECHAT_MCH_SERIAL_NO: 'SERIAL-NO',
        WECHAT_MCH_PRIVATE_KEY: merchantKeys.privateKey
          .export({ type: 'pkcs8', format: 'pem' })
          .toString(),
      },
      databasePath: ':memory:',
      logger: false,
      serveStatic: false,
      fetch: async () => {
        throw new Error('simulated network failure')
      },
    })
    try {
      const publicToken = wechatApp.jwt.sign({ role: 'public', openid: 'wx-openid-1' })
      const failed = await wechatApp.inject({
        method: 'POST',
        url: '/api/public/orders',
        headers: { cookie: `park_session=${publicToken}` },
        payload: orderPayload(),
      })
      expect(failed.statusCode).toBe(502)
      expect(body<{ error: { code: string } }>(failed).error.code).toBe('WECHAT_NETWORK_ERROR')

      const cookie = await adminCookie(wechatApp)
      const orders = await wechatApp.inject({
        method: 'GET',
        url: '/api/admin/orders',
        headers: { cookie },
      })
      const data = body<{ data: { total: number; items: Array<{ status: string }> } }>(orders).data
      expect(data.total).toBe(1)
      expect(data.items[0]?.status).toBe('closed')
    } finally {
      await wechatApp.close()
    }
  })

  it('拒绝缺项或重复项的价格矩阵', async () => {
    const cookie = await adminCookie(app)
    const duplicated = Array.from({ length: 8 }, () => ({
      customerType: 'merchant',
      durationMonths: 1,
      amount: 100,
    }))
    const response = await app.inject({
      method: 'PUT',
      url: '/api/admin/prices',
      headers: { cookie },
      payload: { items: duplicated },
    })
    expect(response.statusCode).toBe(400)
    expect(body<{ error: { code: string } }>(response).error.code).toBe('INVALID_PRICE_MATRIX')
  })

  it('管理员连续登录失败后按来源 IP 临时限速', async () => {
    for (let index = 0; index < 4; index += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/login',
        remoteAddress: '203.0.113.10',
        payload: { password: 'wrong-password' },
      })
      expect(response.statusCode).toBe(401)
    }
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/admin/login',
      remoteAddress: '203.0.113.10',
      payload: { password: 'wrong-password' },
    })
    expect(blocked.statusCode).toBe(429)
    expect(body<{ error: { code: string } }>(blocked).error.code).toBe('LOGIN_RATE_LIMITED')

    const stillBlocked = await app.inject({
      method: 'POST',
      url: '/api/admin/login',
      remoteAddress: '203.0.113.10',
      payload: { password: testEnv.ADMIN_PASSWORD },
    })
    expect(stillBlocked.statusCode).toBe(429)
  })
})
