import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../../src/server/app.js'

const testEnv = {
  NODE_ENV: 'test',
  PAYMENT_MODE: 'mock',
  JWT_SECRET: 'manual-pricing-test-secret-at-least-32-characters',
  ADMIN_PASSWORD: 'manual-pricing-password',
}

type Price = { customerType: 'merchant' | 'resident'; durationMonths: 1 | 3 | 6 | 12; amount: number; mode: 'fixed' | 'manual' }
type PriceResponse = { version: number; enabled: boolean; enabledDurations: number[]; items: Price[] }

function data<T>(response: { json(): unknown }): T {
  return (response.json() as { data: T }).data
}

function errorCode(response: { json(): unknown }): string {
  return (response.json() as { error: { code: string } }).error.code
}

function payload(version: number, amount: number, overrides: Record<string, unknown> = {}) {
  return {
    clientRequestId: randomUUID(),
    priceVersion: version,
    expectedAmount: amount,
    customerType: 'merchant',
    contactName: '测试用户',
    contactPhone: '13800138000',
    address: '1号楼101',
    plateNumber: '新A12345',
    durationMonths: 1,
    ...overrides,
  }
}

describe('固定价与缴费人手动填写金额', () => {
  let app: FastifyInstance
  let cookie: string
  let lotId: string

  beforeEach(async () => {
    app = await createApp({ env: testEnv, databasePath: ':memory:', serveStatic: false })
    const login = await app.inject({
      method: 'POST', url: '/api/admin/login', payload: { password: testEnv.ADMIN_PASSWORD },
    })
    expect(login.statusCode).toBe(200)
    const header = login.headers['set-cookie']
    cookie = (Array.isArray(header) ? header[0] : header ?? '').split(';', 1)[0]
    lotId = data<Array<{ id: string }>>(await app.inject({
      method: 'GET', url: '/api/admin/parking-lots', headers: { cookie },
    }))[0].id
  })

  afterEach(async () => { await app.close() })

  async function prices(parkingLotId = lotId): Promise<PriceResponse> {
    const response = await app.inject({
      method: 'GET', url: `/api/admin/prices?parkingLotId=${parkingLotId}`, headers: { cookie },
    })
    expect(response.statusCode).toBe(200)
    return data<PriceResponse>(response)
  }

  async function save(items: Price[], enabledDurations?: number[], parkingLotId = lotId): Promise<PriceResponse> {
    const response = await app.inject({
      method: 'PUT', url: `/api/admin/prices?parkingLotId=${parkingLotId}`,
      headers: { cookie }, payload: { items, ...(enabledDurations ? { enabledDurations } : {}) },
    })
    expect(response.statusCode).toBe(200)
    return data<PriceResponse>(response)
  }

  it('手动价必须由新页面明确声明，且只接受 1–100000 元整', async () => {
    const original = await prices()
    expect(original.items.every((item) => item.mode === 'fixed')).toBe(true)
    const updated = await save(original.items.map((item) =>
      item.customerType === 'merchant' && item.durationMonths === 1
        ? { ...item, mode: 'manual', amount: 0 }
        : item,
    ))
    expect(updated).toMatchObject({ version: original.version + 1, enabled: true })
    expect((await prices()).items.find((item) => item.customerType === 'merchant' && item.durationMonths === 1))
      .toMatchObject({ mode: 'manual', amount: 0 })
    expect(data<PriceResponse>(await app.inject({
      method: 'GET', url: `/api/public/prices?parkingLotId=${lotId}`,
    })).items.find((item) => item.customerType === 'merchant' && item.durationMonths === 1))
      .toMatchObject({ mode: 'manual', amount: 0 })

    for (const [amount, mode, expectedStatus, expectedCode] of [
      [100, undefined, 409, 'PRICE_CHANGED'],
      [100, 'fixed', 409, 'PRICE_CHANGED'],
      [0, 'manual', 400, 'INVALID_MANUAL_AMOUNT'],
      [1, 'manual', 400, 'INVALID_MANUAL_AMOUNT'],
      [150, 'manual', 400, 'INVALID_MANUAL_AMOUNT'],
    ] as const) {
      const response = await app.inject({
        method: 'POST', url: '/api/public/orders',
        payload: payload(updated.version, amount, { ...(mode ? { pricingMode: mode } : {}) }),
      })
      expect(response.statusCode).toBe(expectedStatus)
      expect(errorCode(response)).toBe(expectedCode)
    }
    expect((await app.inject({ method: 'POST', url: '/api/public/orders',
      payload: payload(updated.version, 10_000_001, { pricingMode: 'manual' }),
    })).statusCode).toBe(400)

    const smallest = await app.inject({ method: 'POST', url: '/api/public/orders',
      payload: payload(updated.version, 100, { pricingMode: 'manual' }),
    })
    expect(smallest.statusCode).toBe(201)
    expect(data<{ amount: number; pricingMode: string }>(smallest))
      .toMatchObject({ amount: 100, pricingMode: 'manual' })
    const largest = await app.inject({ method: 'POST', url: '/api/public/orders',
      payload: payload(updated.version, 10_000_000, { pricingMode: 'manual', plateNumber: '新A12346' }),
    })
    expect(largest.statusCode).toBe(201)
    expect(data<{ amount: number }>(largest).amount).toBe(10_000_000)

    const paid = await app.inject({ method: 'POST', url: `/api/public/orders/${data<{ id: string }>(smallest).id}/mock-pay` })
    expect(data<{ status: string; amount: number }>(paid)).toMatchObject({ status: 'paid', amount: 100 })
    const refunded = await app.inject({
      method: 'POST', url: `/api/admin/orders/${data<{ id: string }>(smallest).id}/refund`,
      headers: { cookie, 'x-parkfee-admin-action': 'refund' },
    })
    expect(refunded.statusCode).toBe(200)
    expect(data<{ status: string; refund: { amount: number } }>(refunded))
      .toMatchObject({ status: 'refunded', refund: { amount: 100 } })
  })

  it('存在手动价时拒绝旧管理页面省略 mode，切回固定后严格核对金额', async () => {
    const original = await prices()
    const manual = await save(original.items.map((item) =>
      item.customerType === 'merchant' && item.durationMonths === 1 ? { ...item, mode: 'manual' } : item,
    ))
    const staleEdit = await app.inject({
      method: 'PUT', url: `/api/admin/prices?parkingLotId=${lotId}`,
      headers: { cookie }, payload: { items: manual.items, expectedVersion: original.version },
    })
    expect(staleEdit.statusCode).toBe(409)
    expect(errorCode(staleEdit)).toBe('PRICE_CHANGED')
    const oldClient = await app.inject({
      method: 'PUT', url: `/api/admin/prices?parkingLotId=${lotId}`,
      headers: { cookie }, payload: { items: manual.items.map(({ mode: _mode, ...item }) => item) },
    })
    expect(oldClient.statusCode).toBe(409)
    expect(errorCode(oldClient)).toBe('PRICE_CHANGED')
    const retained = await prices()
    expect(retained.version).toBe(manual.version)
    expect(retained.items.find((item) => item.customerType === 'merchant' && item.durationMonths === 1)?.mode)
      .toBe('manual')

    const restoredResponse = await app.inject({
      method: 'PUT', url: `/api/admin/prices?parkingLotId=${lotId}`,
      headers: { cookie },
      payload: {
        expectedVersion: retained.version,
        items: retained.items.map((item) => item.customerType === 'merchant' && item.durationMonths === 1
          ? { ...item, mode: 'fixed', amount: 12_345 }
          : item),
      },
    })
    expect(restoredResponse.statusCode).toBe(200)
    const restored = data<PriceResponse>(restoredResponse)
    const wrongMode = await app.inject({ method: 'POST', url: '/api/public/orders',
      payload: payload(restored.version, 12_345, { pricingMode: 'manual' }),
    })
    expect(errorCode(wrongMode)).toBe('PRICE_CHANGED')
    const wrongAmount = await app.inject({ method: 'POST', url: '/api/public/orders',
      payload: payload(restored.version, 100, { pricingMode: 'fixed' }),
    })
    expect(errorCode(wrongAmount)).toBe('PRICE_CHANGED')
    const valid = await app.inject({ method: 'POST', url: '/api/public/orders',
      payload: payload(restored.version, 12_345, { pricingMode: 'fixed' }),
    })
    expect(valid.statusCode).toBe(201)
    expect(data<{ amount: number }>(valid).amount).toBe(12_345)
  })

  it('手动金额依旧受停车场、时长、价格版本和幂等键约束', async () => {
    const original = await prices()
    const first = await save(original.items.map((item) => ({ ...item, mode: 'manual', amount: 0 })), [6])
    const disabled = await app.inject({ method: 'POST', url: '/api/public/orders',
      payload: payload(first.version, 100, { pricingMode: 'manual' }),
    })
    expect(errorCode(disabled)).toBe('DURATION_DISABLED')

    const secondLot = await app.inject({ method: 'POST', url: '/api/admin/parking-lots',
      headers: { cookie }, payload: { name: '手动金额测试停车场' },
    })
    const secondId = data<{ id: string }>(secondLot).id
    const secondPrices = await prices(secondId)
    const second = await save(secondPrices.items.map((item) => ({ ...item, mode: 'manual' })), [1], secondId)
    expect(second.enabled).toBe(true)
    expect((await app.inject({ method: 'PATCH', url: `/api/admin/parking-lots/${secondId}`,
      headers: { cookie }, payload: { active: true },
    })).statusCode).toBe(200)

    const requestId = randomUUID()
    const orderPayload = payload(second.version, 500, {
      parkingLotId: secondId, pricingMode: 'manual', clientRequestId: requestId,
    })
    const created = await app.inject({ method: 'POST', url: '/api/public/orders', payload: orderPayload })
    expect(created.statusCode).toBe(201)
    const replay = await app.inject({ method: 'POST', url: '/api/public/orders', payload: orderPayload })
    expect(replay.statusCode).toBe(200)
    expect(data<{ id: string }>(replay).id).toBe(data<{ id: string }>(created).id)
    const conflict = await app.inject({ method: 'POST', url: '/api/public/orders',
      payload: { ...orderPayload, expectedAmount: 600 },
    })
    expect(errorCode(conflict)).toBe('IDEMPOTENCY_CONFLICT')
    const modeConflict = await app.inject({ method: 'POST', url: '/api/public/orders',
      payload: { ...orderPayload, pricingMode: 'fixed' },
    })
    expect(errorCode(modeConflict)).toBe('IDEMPOTENCY_CONFLICT')
    const wrongLot = await app.inject({ method: 'POST', url: '/api/public/orders',
      payload: payload(second.version, 500, { parkingLotId: lotId, pricingMode: 'manual' }),
    })
    expect(errorCode(wrongLot)).toBe('PRICE_CHANGED')
    const wrongVersion = await app.inject({ method: 'POST', url: '/api/public/orders',
      payload: payload(secondPrices.version, 500, { parkingLotId: secondId, pricingMode: 'manual' }),
    })
    expect(errorCode(wrongVersion)).toBe('PRICE_CHANGED')
  })
})
