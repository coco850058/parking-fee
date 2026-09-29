import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../../src/server/app.js'

const testEnv = {
  NODE_ENV: 'test',
  PAYMENT_MODE: 'mock',
  JWT_SECRET: 'test-secret-with-more-than-thirty-two-characters',
  ADMIN_PASSWORD: 'correct horse battery staple',
}

interface Summary {
  today: { count: number; amount: number }
  month: { count: number; amount: number }
  all: { count: number; amount: number }
  selected: { count: number; amount: number }
  availableYears: number[]
  pendingCount: number
}

function data<T>(response: { json(): unknown }): T {
  return (response.json() as { data: T }).data
}

async function login(app: FastifyInstance): Promise<string> {
  const response = await app.inject({
    method: 'POST', url: '/api/admin/login', payload: { password: testEnv.ADMIN_PASSWORD },
  })
  expect(response.statusCode).toBe(200)
  const header = response.headers['set-cookie']
  const value = Array.isArray(header) ? header[0] : header
  if (!value) throw new Error('缺少管理 Cookie')
  return value.split(';', 1)[0]
}

describe('管理端期间汇总与日期筛选', () => {
  let app: FastifyInstance | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('按北京时间统计本周、本月、本年与历史年，并保留旧汇总字段', async () => {
    let clock = new Date('2025-12-31T15:59:59.999Z')
    app = await createApp({ env: testEnv, databasePath: ':memory:', serveStatic: false, now: () => clock })
    const cookie = await login(app)

    async function payAt(timestamp: string, plateNumber: string): Promise<string> {
      clock = new Date(timestamp)
      const created = await app!.inject({
        method: 'POST', url: '/api/public/orders',
        payload: {
          clientRequestId: randomUUID(), priceVersion: 1, expectedAmount: 10_000,
          customerType: 'merchant', address: '期间测试', plateNumber, durationMonths: 1,
        },
      })
      expect(created.statusCode).toBe(201)
      const id = data<{ id: string }>(created).id
      const paid = await app!.inject({ method: 'POST', url: `/api/public/orders/${id}/mock-pay` })
      expect(paid.statusCode).toBe(200)
      return id
    }

    const previousYearId = await payAt('2025-12-31T15:59:59.999Z', '粤B10001') // 北京时间 2025-12-31 23:59
    await payAt('2025-12-31T16:00:00.000Z', '粤B10002') // 2026-01-01 00:00
    await payAt('2026-09-27T15:59:59.999Z', '粤B10003') // 周日 23:59
    await payAt('2026-09-27T16:00:00.000Z', '粤B10004') // 周一 00:00
    const refundedId = await payAt('2026-09-28T16:00:00.000Z', '粤B10005') // 周二 00:00
    clock = new Date('2026-09-29T00:00:00.000Z')

    const expected: Array<[string, number]> = [
      ['today', 1], ['week', 2], ['month', 3], ['year', 4], ['year&year=2025', 1],
    ]
    for (const [query, count] of expected) {
      const response = await app.inject({
        method: 'GET', url: `/api/admin/summary?period=${query}`, headers: { cookie },
      })
      expect(response.statusCode).toBe(200)
      expect(data<Summary>(response).selected).toEqual({ count, amount: count * 10_000 })
    }

    const legacy = await app.inject({ method: 'GET', url: '/api/admin/summary', headers: { cookie } })
    expect(data<Summary>(legacy)).toMatchObject({
      today: { count: 1, amount: 10_000 },
      month: { count: 3, amount: 30_000 },
      all: { count: 5, amount: 50_000 },
      selected: { count: 1, amount: 10_000 },
      availableYears: [2026, 2025],
      pendingCount: 0,
    })

    const refund = await app.inject({
      method: 'POST', url: `/api/admin/orders/${refundedId}/refund`,
      headers: { cookie, 'x-parkfee-admin-action': 'refund' },
    })
    expect(refund.statusCode).toBe(200)
    const afterRefund = await app.inject({
      method: 'GET', url: '/api/admin/summary?period=week', headers: { cookie },
    })
    expect(data<Summary>(afterRefund)).toMatchObject({
      selected: { count: 1, amount: 10_000 },
      all: { count: 4, amount: 40_000 },
      availableYears: [2026, 2025],
    })
    const previousYearRefund = await app.inject({
      method: 'POST', url: `/api/admin/orders/${previousYearId}/refund`,
      headers: { cookie, 'x-parkfee-admin-action': 'refund' },
    })
    expect(previousYearRefund.statusCode).toBe(200)
    const emptyYear = await app.inject({
      method: 'GET', url: '/api/admin/summary?period=year&year=2025', headers: { cookie },
    })
    expect(data<Summary>(emptyYear)).toMatchObject({
      selected: { count: 0, amount: 0 }, availableYears: [2026, 2025],
    })
  })

  it('同日筛选含全天，列表与 CSV 同条件，并拒绝无效或倒置日期', async () => {
    let clock = new Date('2024-02-28T15:59:59.999Z')
    app = await createApp({ env: testEnv, databasePath: ':memory:', serveStatic: false, now: () => clock })
    const cookie = await login(app)
    const orders: Array<{ id: string; plate: string }> = []
    for (const [timestamp, plate] of [
      ['2024-02-28T15:59:59.999Z', '粤B20001'],
      ['2024-02-28T16:00:00.000Z', '粤B20002'],
      ['2024-02-29T15:59:59.999Z', '粤B20003'],
      ['2024-02-29T16:00:00.000Z', '粤B20004'],
    ]) {
      clock = new Date(timestamp)
      const response = await app.inject({
        method: 'POST', url: '/api/public/orders',
        payload: {
          clientRequestId: randomUUID(), priceVersion: 1, expectedAmount: 10_000,
          customerType: 'merchant', address: '闰日测试', plateNumber: plate, durationMonths: 1,
        },
      })
      expect(response.statusCode).toBe(201)
      const id = data<{ id: string }>(response).id
      orders.push({ id, plate })
      expect((await app.inject({ method: 'POST', url: `/api/public/orders/${id}/mock-pay` })).statusCode).toBe(200)
    }

    const query = 'from=2024-02-29&to=2024-02-29&status=paid&customerType=merchant&durationMonths=1&keyword=闰日'
    const list = await app.inject({ method: 'GET', url: `/api/admin/orders?${query}`, headers: { cookie } })
    expect(list.statusCode).toBe(200)
    expect(data<{ total: number; items: Array<{ id: string }> }>(list)).toMatchObject({ total: 2 })
    expect(data<{ items: Array<{ id: string }> }>(list).items.map((item) => item.id).sort())
      .toEqual([orders[1].id, orders[2].id].sort())

    const csv = await app.inject({ method: 'GET', url: `/api/admin/orders/export.csv?${query}`, headers: { cookie } })
    expect(csv.statusCode).toBe(200)
    expect(csv.body).toContain(orders[1].plate)
    expect(csv.body).toContain(orders[2].plate)
    expect(csv.body).not.toContain(orders[0].plate)
    expect(csv.body).not.toContain(orders[3].plate)

    for (const invalidQuery of [
      'from=2024-02-30',
      'to=2023-02-29',
      'from=2024-03-01&to=2024-02-29',
      'from=2026-02-30%2000:00',
      'from=2026-02-30T00:00:00Z',
      'to=2026-09-29T12:00:00',
    ]) {
      for (const path of ['/api/admin/orders', '/api/admin/orders/export.csv']) {
        const response = await app.inject({
          method: 'GET', url: `${path}?${invalidQuery}`, headers: { cookie },
        })
        expect(response.statusCode).toBe(400)
      }
    }
  })

  it('拒绝非年度模式的 year 和未来年份', async () => {
    const clock = new Date('2026-09-29T00:00:00.000Z')
    app = await createApp({ env: testEnv, databasePath: ':memory:', serveStatic: false, now: () => clock })
    const cookie = await login(app)
    for (const query of ['period=month&year=2025', 'period=year&year=2027', 'period=unknown']) {
      const response = await app.inject({ method: 'GET', url: `/api/admin/summary?${query}`, headers: { cookie } })
      expect(response.statusCode).toBe(400)
    }
  })
})
