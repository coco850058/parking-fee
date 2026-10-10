import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../../src/server/app.js'

const testEnv = {
  NODE_ENV: 'test',
  PAYMENT_MODE: 'mock',
  JWT_SECRET: 'duration-test-secret-with-more-than-thirty-two-characters',
  ADMIN_PASSWORD: 'duration-test-password',
  PUBLIC_BASE_URL: 'https://pay.example.com',
}

function data<T>(response: { json(): unknown }): T {
  return (response.json() as { data: T }).data
}

function errorCode(response: { json(): unknown }): string {
  return (response.json() as { error: { code: string } }).error.code
}

function items(amounts: Record<1 | 3 | 6 | 12, number>) {
  return (['merchant', 'resident'] as const).flatMap((customerType) =>
    ([1, 3, 6, 12] as const).map((durationMonths) => ({
      customerType, durationMonths, amount: amounts[durationMonths],
    })),
  )
}

function orderPayload(parkingLotId: string, priceVersion: number, durationMonths: number, expectedAmount: number) {
  return {
    parkingLotId,
    clientRequestId: randomUUID(),
    customerType: 'resident',
    address: '测试地址',
    plateNumber: '新A12345',
    durationMonths,
    priceVersion,
    expectedAmount,
  }
}

describe('按停车场配置缴费时长', () => {
  let app: FastifyInstance
  let adminCookie: string
  let firstLotId: string

  beforeEach(async () => {
    app = await createApp({ env: testEnv, databasePath: ':memory:', serveStatic: false })
    const login = await app.inject({
      method: 'POST', url: '/api/admin/login', payload: { password: testEnv.ADMIN_PASSWORD },
    })
    expect(login.statusCode).toBe(200)
    const cookie = login.headers['set-cookie']
    adminCookie = (Array.isArray(cookie) ? cookie[0] : cookie ?? '').split(';', 1)[0]
    firstLotId = data<Array<{ id: string }>>(await app.inject({
      method: 'GET', url: '/api/admin/parking-lots', headers: { cookie: adminCookie },
    }))[0].id
  })

  afterEach(async () => { await app.close() })

  it('旧场默认全开放；调成仅半年、一年后版本递增，旧订单可支付，过期页面与禁用时长不得新下单', async () => {
    const original = data<{ version: number; enabled: boolean; enabledDurations: number[] }>(await app.inject({
      method: 'GET', url: `/api/public/prices?parkingLotId=${firstLotId}`,
    }))
    expect(original).toMatchObject({ version: 1, enabled: true, enabledDurations: [1, 3, 6, 12] })

    const existing = await app.inject({
      method: 'POST', url: '/api/public/orders',
      payload: orderPayload(firstLotId, original.version, 1, 8_000),
    })
    expect(existing.statusCode).toBe(201)
    const oldOrderId = data<{ id: string }>(existing).id

    const updated = await app.inject({
      method: 'PUT', url: `/api/admin/prices?parkingLotId=${firstLotId}`,
      headers: { cookie: adminCookie },
      payload: { items: items({ 1: 0, 3: 0, 6: 4_200, 12: 8_000 }), enabledDurations: [12, 6] },
    })
    expect(updated.statusCode).toBe(200)
    const current = data<{ version: number; enabled: boolean; enabledDurations: number[] }>(updated)
    expect(current.version).toBeGreaterThan(original.version)
    expect(current).toMatchObject({ enabled: true, enabledDurations: [6, 12] })
    expect(data<{ enabledDurations: number[] }>(await app.inject({
      method: 'GET', url: `/api/public/prices?parkingLotId=${firstLotId}`,
    })).enabledDurations).toEqual([6, 12])

    const stale = await app.inject({
      method: 'POST', url: '/api/public/orders',
      payload: orderPayload(firstLotId, original.version, 1, 8_000),
    })
    expect(stale.statusCode).toBe(409)
    expect(errorCode(stale)).toBe('PRICE_CHANGED')
    const disabled = await app.inject({
      method: 'POST', url: '/api/public/orders',
      payload: orderPayload(firstLotId, current.version, 1, 0),
    })
    expect(disabled.statusCode).toBe(409)
    expect(errorCode(disabled)).toBe('DURATION_DISABLED')
    expect((await app.inject({
      method: 'POST', url: '/api/public/orders',
      payload: orderPayload(firstLotId, current.version, 6, 4_200),
    })).statusCode).toBe(201)

    expect((await app.inject({ method: 'POST', url: `/api/public/orders/${oldOrderId}/mock-pay` })).statusCode).toBe(200)
    expect(data<{ amount: number; durationMonths: number; status: string }>(await app.inject({
      method: 'GET', url: `/api/public/orders/${oldOrderId}`,
    }))).toMatchObject({ amount: 8_000, durationMonths: 1, status: 'paid' })

    const priceOnlyUpdate = await app.inject({
      method: 'PUT', url: `/api/admin/prices?parkingLotId=${firstLotId}`,
      headers: { cookie: adminCookie },
      payload: { items: items({ 1: 0, 3: 0, 6: 4_300, 12: 8_100 }) },
    })
    expect(priceOnlyUpdate.statusCode).toBe(200)
    expect(data<{ version: number; enabledDurations: number[] }>(priceOnlyUpdate))
      .toMatchObject({ version: current.version + 1, enabledDurations: [6, 12] })
  })

  it('新场可只给启用时长定价后启用，其他停车场的可选项不受影响', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/admin/parking-lots',
      headers: { cookie: adminCookie }, payload: { name: '短时长测试停车场' },
    })
    expect(created.statusCode).toBe(201)
    const secondLotId = data<{ id: string }>(created).id
    expect(data<{ enabledDurations: number[] }>(await app.inject({
      method: 'GET', url: `/api/admin/prices?parkingLotId=${secondLotId}`,
      headers: { cookie: adminCookie },
    })).enabledDurations).toEqual([1, 3, 6, 12])

    const unpriced = await app.inject({
      method: 'PUT', url: `/api/admin/prices?parkingLotId=${secondLotId}`,
      headers: { cookie: adminCookie },
      payload: { items: items({ 1: 0, 3: 0, 6: 0, 12: 0 }), enabledDurations: [6, 12] },
    })
    expect(data<{ enabled: boolean }>(unpriced).enabled).toBe(false)
    const premature = await app.inject({
      method: 'PATCH', url: `/api/admin/parking-lots/${secondLotId}`,
      headers: { cookie: adminCookie }, payload: { active: true },
    })
    expect(premature.statusCode).toBe(409)
    expect(errorCode(premature)).toBe('PARKING_LOT_PRICE_NOT_CONFIGURED')

    const priced = await app.inject({
      method: 'PUT', url: `/api/admin/prices?parkingLotId=${secondLotId}`,
      headers: { cookie: adminCookie },
      payload: { items: items({ 1: 0, 3: 0, 6: 600, 12: 1_200 }), enabledDurations: [6, 12] },
    })
    expect(data<{ enabled: boolean }>(priced).enabled).toBe(true)
    expect((await app.inject({
      method: 'PATCH', url: `/api/admin/parking-lots/${secondLotId}`,
      headers: { cookie: adminCookie }, payload: { active: true },
    })).statusCode).toBe(200)
    expect(data<{ enabledDurations: number[] }>(await app.inject({
      method: 'GET', url: `/api/public/prices?parkingLotId=${firstLotId}`,
    })).enabledDurations).toEqual([1, 3, 6, 12])
    expect(data<{ enabledDurations: number[] }>(await app.inject({
      method: 'GET', url: `/api/public/prices?parkingLotId=${secondLotId}`,
    })).enabledDurations).toEqual([6, 12])
  })

  it('拒绝空、重复或无效时长，且不生成新价格版本', async () => {
    const before = data<{ version: number }>(await app.inject({
      method: 'GET', url: `/api/admin/prices?parkingLotId=${firstLotId}`,
      headers: { cookie: adminCookie },
    })).version
    for (const enabledDurations of [[], [6, 6], [2], [1, 13], null]) {
      const response = await app.inject({
        method: 'PUT', url: `/api/admin/prices?parkingLotId=${firstLotId}`,
        headers: { cookie: adminCookie },
        payload: { items: items({ 1: 100, 3: 300, 6: 600, 12: 1_200 }), enabledDurations },
      })
      expect(response.statusCode).toBe(400)
    }
    expect(data<{ version: number }>(await app.inject({
      method: 'GET', url: `/api/admin/prices?parkingLotId=${firstLotId}`,
      headers: { cookie: adminCookie },
    })).version).toBe(before)
  })
})
