import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { INITIAL_PARKING_LOT_NAME } from '../../src/server/database.js'

const testEnv = {
  NODE_ENV: 'test',
  PAYMENT_MODE: 'mock',
  JWT_SECRET: 'test-secret-with-more-than-thirty-two-characters',
  ADMIN_PASSWORD: 'correct horse battery staple',
  PUBLIC_BASE_URL: 'https://pay.example.com',
}

function data<T>(response: { json(): unknown }): T {
  return (response.json() as { data: T }).data
}

function errorCode(response: { json(): unknown }): string {
  return (response.json() as { error: { code: string } }).error.code
}

function cookieFrom(response: { headers: Record<string, string | string[] | undefined> }, name: string): string {
  const headers = response.headers['set-cookie']
  const cookies = Array.isArray(headers) ? headers : headers ? [headers] : []
  const cookie = cookies.find((value) => value.startsWith(`${name}=`))
  if (!cookie) throw new Error(`响应未设置 ${name} Cookie`)
  return cookie.split(';', 1)[0]
}

async function login(app: FastifyInstance): Promise<string> {
  const response = await app.inject({
    method: 'POST', url: '/api/admin/login', payload: { password: testEnv.ADMIN_PASSWORD },
  })
  expect(response.statusCode).toBe(200)
  return cookieFrom(response, 'park_admin')
}

function priceItems(amount: number) {
  return (['merchant', 'resident'] as const).flatMap((customerType) =>
    ([1, 3, 6, 12] as const).map((durationMonths) => ({ customerType, durationMonths, amount })),
  )
}

function orderPayload(parkingLotId: string | undefined, priceVersion: number, expectedAmount: number, plateNumber: string, clientRequestId = randomUUID()) {
  return {
    parkingLotId, clientRequestId, priceVersion, expectedAmount,
    customerType: 'merchant', address: '测试地址', plateNumber, durationMonths: 1,
  }
}

describe('多停车场隔离', () => {
  let app: FastifyInstance
  let adminCookie: string

  beforeEach(async () => {
    app = await createApp({ env: testEnv, databasePath: ':memory:', serveStatic: false })
    adminCookie = await login(app)
  })

  afterEach(async () => { await app.close() })

  it('首场启用、新场先零价停用；启用后旧入口要求选择且价格与订单不串场', async () => {
    const initial = await app.inject({ method: 'GET', url: '/api/admin/parking-lots', headers: { cookie: adminCookie } })
    expect(initial.statusCode).toBe(200)
    const first = data<Array<{ id: string; name: string; active: boolean; paymentUrl: string }>>(initial)[0]
    expect(first).toMatchObject({ name: INITIAL_PARKING_LOT_NAME, active: true })
    expect(first.paymentUrl).toBe(`https://pay.example.com/#/pay/${first.id}`)

    const created = await app.inject({
      method: 'POST', url: '/api/admin/parking-lots', headers: { cookie: adminCookie },
      payload: { name: '备用停车场' },
    })
    expect(created.statusCode).toBe(201)
    const second = data<{ id: string; active: boolean; paymentUrl: string }>(created)
    expect(second.active).toBe(false)
    expect(second.paymentUrl).toBe(`https://pay.example.com/#/pay/${second.id}`)

    const zero = await app.inject({ method: 'GET', url: `/api/admin/prices?parkingLotId=${second.id}`, headers: { cookie: adminCookie } })
    expect(data<{ enabled: boolean; items: Array<{ amount: number }> }>(zero)).toMatchObject({ enabled: false })
    expect(data<{ items: Array<{ amount: number }> }>(zero).items.every((item) => item.amount === 0)).toBe(true)
    const premature = await app.inject({
      method: 'PATCH', url: `/api/admin/parking-lots/${second.id}`,
      headers: { cookie: adminCookie }, payload: { active: true },
    })
    expect(premature.statusCode).toBe(409)
    expect(errorCode(premature)).toBe('PARKING_LOT_PRICE_NOT_CONFIGURED')
    expect(data<Array<{ id: string }>>(await app.inject({ method: 'GET', url: '/api/public/parking-lots' })))
      .toEqual([{ id: first.id, name: first.name, platePrefix: '新A' }])

    const priced = await app.inject({
      method: 'PUT', url: `/api/admin/prices?parkingLotId=${second.id}`,
      headers: { cookie: adminCookie }, payload: { items: priceItems(25_000) },
    })
    expect(priced.statusCode).toBe(200)
    const secondVersion = data<{ version: number }>(priced).version
    expect(secondVersion).toBeGreaterThan(1)
    expect((await app.inject({
      method: 'PATCH', url: `/api/admin/parking-lots/${second.id}`,
      headers: { cookie: adminCookie }, payload: { active: true },
    })).statusCode).toBe(200)

    const genericPrice = await app.inject({ method: 'GET', url: '/api/public/prices' })
    expect(genericPrice.statusCode).toBe(400)
    expect(errorCode(genericPrice)).toBe('PARKING_LOT_REQUIRED')
    const genericOrder = await app.inject({
      method: 'POST', url: '/api/public/orders',
      payload: orderPayload(undefined, 1, 10_000, '新A10001'),
    })
    expect(genericOrder.statusCode).toBe(400)
    expect(errorCode(genericOrder)).toBe('PARKING_LOT_REQUIRED')

    const firstPrices = data<{ version: number; items: Array<{ amount: number }> }>(await app.inject({
      method: 'GET', url: `/api/public/prices?parkingLotId=${first.id}`,
    }))
    const secondPrices = data<{ version: number; items: Array<{ amount: number }> }>(await app.inject({
      method: 'GET', url: `/api/public/prices?parkingLotId=${second.id}`,
    }))
    expect(firstPrices.version).toBe(1)
    expect(firstPrices.items[0].amount).toBe(10_000)
    expect(secondPrices.version).toBe(secondVersion)
    expect(secondPrices.items[0].amount).toBe(25_000)

    const firstOrder = await app.inject({
      method: 'POST', url: '/api/public/orders',
      payload: orderPayload(first.id, 1, 10_000, '新A10001'),
    })
    expect(firstOrder.statusCode).toBe(201)
    const firstRecord = data<{ id: string; parkingLotId: string; parkingLotName: string }>(firstOrder)
    expect(firstRecord).toMatchObject({ parkingLotId: first.id, parkingLotName: first.name })
    const wrongVersion = await app.inject({
      method: 'POST', url: '/api/public/orders',
      payload: orderPayload(second.id, 1, 10_000, '新A10002'),
    })
    expect(wrongVersion.statusCode).toBe(409)
    expect(errorCode(wrongVersion)).toBe('PRICE_CHANGED')
    const requestId = randomUUID()
    const secondOrder = await app.inject({
      method: 'POST', url: '/api/public/orders',
      payload: orderPayload(second.id, secondVersion, 25_000, '新A10003', requestId),
    })
    expect(secondOrder.statusCode).toBe(201)
    const secondRecord = data<{ id: string; parkingLotId: string; parkingLotName: string }>(secondOrder)
    expect(secondRecord).toMatchObject({ parkingLotId: second.id, parkingLotName: '备用停车场' })
    const crossIdempotency = await app.inject({
      method: 'POST', url: '/api/public/orders',
      payload: orderPayload(first.id, 1, 10_000, '新A10003', requestId),
    })
    expect(crossIdempotency.statusCode).toBe(409)
    expect(errorCode(crossIdempotency)).toBe('IDEMPOTENCY_CONFLICT')

    expect((await app.inject({ method: 'POST', url: `/api/public/orders/${firstRecord.id}/mock-pay` })).statusCode).toBe(200)
    expect((await app.inject({ method: 'POST', url: `/api/public/orders/${secondRecord.id}/mock-pay` })).statusCode).toBe(200)
    const summary = await app.inject({
      method: 'GET', url: `/api/admin/summary?parkingLotId=${second.id}`,
      headers: { cookie: adminCookie },
    })
    expect(data<{ all: { count: number; amount: number } }>(summary).all).toEqual({ count: 1, amount: 25_000 })
    const allSummary = await app.inject({ method: 'GET', url: '/api/admin/summary', headers: { cookie: adminCookie } })
    expect(data<{ all: { count: number; amount: number } }>(allSummary).all).toEqual({ count: 2, amount: 35_000 })
    const filtered = await app.inject({
      method: 'GET', url: `/api/admin/orders?parkingLotId=${second.id}`,
      headers: { cookie: adminCookie },
    })
    expect(data<{ total: number; items: Array<{ parkingLotId: string }> }>(filtered)).toMatchObject({ total: 1 })
    expect(data<{ items: Array<{ parkingLotId: string }> }>(filtered).items[0].parkingLotId).toBe(second.id)
    const csv = await app.inject({
      method: 'GET', url: `/api/admin/orders/export.csv?parkingLotId=${second.id}`,
      headers: { cookie: adminCookie },
    })
    expect(csv.body).toContain('备用停车场')
    expect(csv.body).toContain('新A10003')
    expect(csv.body).not.toContain('新A10001')

    const renamed = await app.inject({
      method: 'PATCH', url: `/api/admin/parking-lots/${second.id}`,
      headers: { cookie: adminCookie }, payload: { name: '新名称停车场', active: false },
    })
    expect(renamed.statusCode).toBe(200)
    const oldOrder = await app.inject({ method: 'GET', url: `/api/public/orders/${secondRecord.id}` })
    expect(data<{ parkingLotName: string }>(oldOrder).parkingLotName).toBe('备用停车场')
    const disabled = await app.inject({ method: 'GET', url: `/api/public/parking-lots/${second.id}` })
    expect(disabled.statusCode).toBe(404)
    expect(errorCode(disabled)).toBe('PARKING_LOT_UNAVAILABLE')
    const history = await app.inject({ method: 'GET', url: '/api/public/orders/history' })
    expect(data<{ items: Array<{ parkingLotName: string }> }>(history).items.map((item) => item.parkingLotName))
      .toContain('备用停车场')
  })

  it('每个停车场可设置车牌默认前缀，公开接口只返回启用场地且拒绝无效前缀', async () => {
    const initial = data<Array<{ id: string; name: string; platePrefix: string }>>(await app.inject({
      method: 'GET', url: '/api/admin/parking-lots', headers: { cookie: adminCookie },
    }))[0]
    expect(initial.platePrefix).toBe('新A')
    expect(data<Array<{ id: string; platePrefix: string }>>(await app.inject({
      method: 'GET', url: '/api/public/parking-lots',
    }))).toEqual([{ id: initial.id, name: initial.name, platePrefix: '新A' }])
    expect(data<{ platePrefix: string }>(await app.inject({
      method: 'GET', url: `/api/public/parking-lots/${initial.id}`,
    })).platePrefix).toBe('新A')

    const created = await app.inject({
      method: 'POST', url: '/api/admin/parking-lots', headers: { cookie: adminCookie },
      payload: { name: '前缀测试停车场', platePrefix: '粤 b' },
    })
    expect(created.statusCode).toBe(201)
    const second = data<{ id: string; active: boolean; platePrefix: string }>(created)
    expect(second).toMatchObject({ active: false, platePrefix: '粤B' })
    expect(data<Array<{ id: string; platePrefix: string }>>(await app.inject({
      method: 'GET', url: '/api/admin/parking-lots', headers: { cookie: adminCookie },
    })).find((lot) => lot.id === second.id)?.platePrefix).toBe('粤B')

    const changed = await app.inject({
      method: 'PATCH', url: `/api/admin/parking-lots/${second.id}`,
      headers: { cookie: adminCookie }, payload: { platePrefix: '沪D' },
    })
    expect(changed.statusCode).toBe(200)
    expect(data<{ platePrefix: string }>(changed).platePrefix).toBe('沪D')
    const inactive = await app.inject({ method: 'GET', url: `/api/public/parking-lots/${second.id}` })
    expect(inactive.statusCode).toBe(404)

    for (const platePrefix of ['新I', '新O', '假A', '新1', '新AB', '']) {
      const invalid = await app.inject({
        method: 'PATCH', url: `/api/admin/parking-lots/${second.id}`,
        headers: { cookie: adminCookie }, payload: { platePrefix },
      })
      expect(invalid.statusCode).toBe(400)
    }
    expect((await app.inject({
      method: 'POST', url: '/api/admin/parking-lots', headers: { cookie: adminCookie },
      payload: { name: '错误前缀停车场', platePrefix: '假A' },
    })).statusCode).toBe(400)
    expect(data<Array<{ id: string; platePrefix: string }>>(await app.inject({
      method: 'GET', url: '/api/admin/parking-lots', headers: { cookie: adminCookie },
    })).find((lot) => lot.id === second.id)?.platePrefix).toBe('沪D')

    const priced = await app.inject({
      method: 'PUT', url: `/api/admin/prices?parkingLotId=${second.id}`,
      headers: { cookie: adminCookie }, payload: { items: priceItems(100) },
    })
    expect(priced.statusCode).toBe(200)
    expect((await app.inject({
      method: 'PATCH', url: `/api/admin/parking-lots/${second.id}`,
      headers: { cookie: adminCookie }, payload: { active: true },
    })).statusCode).toBe(200)
    const publicLots = data<Array<{ id: string; platePrefix: string }>>(await app.inject({
      method: 'GET', url: '/api/public/parking-lots',
    }))
    expect(publicLots.find((lot) => lot.id === second.id)?.platePrefix).toBe('沪D')
    expect(data<{ platePrefix: string }>(await app.inject({
      method: 'GET', url: `/api/public/parking-lots/${second.id}`,
    })).platePrefix).toBe('沪D')

    const defaulted = await app.inject({
      method: 'POST', url: '/api/admin/parking-lots', headers: { cookie: adminCookie },
      payload: { name: '另一测试停车场' },
    })
    expect(defaulted.statusCode).toBe(201)
    expect(data<{ platePrefix: string }>(defaulted).platePrefix).toBe('新A')
  })

  it('微信 OAuth 状态绑定停车场，已登录 Cookie 也不能跳过回调状态校验', async () => {
    const wxApp = await createApp({
      env: {
        ...testEnv,
        PAYMENT_MODE: 'wechat',
        WECHAT_APP_ID: 'wx-test-app',
        WECHAT_APP_SECRET: 'app-secret',
      },
      databasePath: ':memory:',
      serveStatic: false,
      fetch: (async () => new Response(JSON.stringify({ openid: 'wx-openid' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch,
    })
    try {
      const lot = data<Array<{ id: string }>>(await wxApp.inject({ method: 'GET', url: '/api/public/parking-lots' }))[0]
      const initiate = await wxApp.inject({ method: 'GET', url: `/api/public/session?parkingLotId=${lot.id}` })
      const oauth = data<{ authorizationUrl: string }>(initiate)
      const state = new URL(oauth.authorizationUrl).searchParams.get('state')!
      const oauthCookie = cookieFrom(initiate, 'park_oauth_state')
      const mismatch = await wxApp.inject({
        method: 'GET', url: `/api/public/session?code=abc&state=wrong&parkingLotId=${lot.id}`,
        headers: { cookie: `${oauthCookie}; park_session=${wxApp.jwt.sign({ role: 'public', openid: 'already' })}` },
      })
      expect(mismatch.statusCode).toBe(400)
      expect(errorCode(mismatch)).toBe('WECHAT_OAUTH_STATE_INVALID')
      const callback = await wxApp.inject({
        method: 'GET', url: `/api/public/session?code=abc&state=${state}`,
        headers: { cookie: oauthCookie },
      })
      expect(callback.statusCode).toBe(200)
      expect(data<{ resumeParkingLotId: string | null }>(callback).resumeParkingLotId).toBe(lot.id)
      expect(cookieFrom(callback, 'park_session')).toMatch(/^park_session=/)

      const historyInitiate = await wxApp.inject({ method: 'GET', url: '/api/public/session' })
      const historyState = new URL(data<{ authorizationUrl: string }>(historyInitiate).authorizationUrl).searchParams.get('state')!
      const historyCallback = await wxApp.inject({
        method: 'GET', url: `/api/public/session?code=history&state=${historyState}`,
        headers: { cookie: cookieFrom(historyInitiate, 'park_oauth_state') },
      })
      expect(data<{ resumeParkingLotId: string | null }>(historyCallback).resumeParkingLotId).toBeNull()
    } finally {
      await wxApp.close()
    }
  })
})
