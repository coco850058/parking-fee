import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'
import { describe, expect, it } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { loadConfig } from '../../src/server/config.js'
import {
  getCurrentPrices,
  getOrderById,
  INITIAL_PARKING_LOT_ID,
  INITIAL_PARKING_LOT_NAME,
  openDatabase,
} from '../../src/server/database.js'

const testEnv = {
  NODE_ENV: 'test',
  PAYMENT_MODE: 'mock',
  JWT_SECRET: 'test-secret-with-more-than-thirty-two-characters',
  ADMIN_PASSWORD: 'correct horse battery staple',
}

function data<T>(response: { json(): unknown }): T {
  return (response.json() as { data: T }).data
}

function errorCode(response: { json(): unknown }): string {
  return (response.json() as { error: { code: string } }).error.code
}

function cookieFrom(response: { headers: Record<string, string | string[] | undefined> }, name: string): string {
  const header = response.headers['set-cookie']
  const cookies = Array.isArray(header) ? header : header ? [header] : []
  const cookie = cookies.find((value) => value.startsWith(`${name}=`))
  if (!cookie) throw new Error(`响应未设置 ${name} Cookie`)
  return cookie.split(';', 1)[0]
}

async function adminCookie(app: FastifyInstance): Promise<string> {
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

async function createActiveSecondLot(app: FastifyInstance, cookie: string): Promise<{ id: string; version: number }> {
  const created = await app.inject({
    method: 'POST', url: '/api/admin/parking-lots', headers: { cookie }, payload: { name: '第二停车场' },
  })
  expect(created.statusCode).toBe(201)
  const { id } = data<{ id: string }>(created)
  const priced = await app.inject({
    method: 'PUT', url: `/api/admin/prices?parkingLotId=${id}`,
    headers: { cookie }, payload: { items: priceItems(25_000) },
  })
  expect(priced.statusCode).toBe(200)
  const { version } = data<{ version: number }>(priced)
  const enabled = await app.inject({
    method: 'PATCH', url: `/api/admin/parking-lots/${id}`, headers: { cookie }, payload: { active: true },
  })
  expect(enabled.statusCode).toBe(200)
  return { id, version }
}

function orderPayload(parkingLotId: string, priceVersion: number, expectedAmount: number, plateNumber: string) {
  return {
    parkingLotId, priceVersion, expectedAmount, plateNumber,
    clientRequestId: randomUUID(), customerType: 'merchant', address: '测试地址', durationMonths: 1,
  }
}

describe('多停车场上线回归', () => {
  it('将已有价格版本、订单及退款记录归入首场，重复启动不改历史数据', () => {
    const directory = mkdtempSync(join(tmpdir(), 'park-fee-lot-migration-'))
    const databasePath = join(directory, 'parking.db')
    try {
      const legacy = new Database(databasePath)
      legacy.exec(`
        CREATE TABLE price_versions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          version_no INTEGER NOT NULL UNIQUE,
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE price_items (
          price_version_id INTEGER NOT NULL REFERENCES price_versions(id) ON DELETE CASCADE,
          customer_type TEXT NOT NULL,
          duration_months INTEGER NOT NULL,
          amount INTEGER NOT NULL,
          PRIMARY KEY (price_version_id, customer_type, duration_months)
        );
        CREATE TABLE orders (
          id TEXT PRIMARY KEY,
          order_no TEXT NOT NULL UNIQUE,
          client_request_id TEXT NOT NULL,
          openid TEXT NOT NULL,
          customer_type TEXT NOT NULL,
          address TEXT NOT NULL,
          plate_number TEXT NOT NULL,
          duration_months INTEGER NOT NULL,
          amount INTEGER NOT NULL,
          price_version_id INTEGER NOT NULL REFERENCES price_versions(id),
          price_version INTEGER NOT NULL,
          price_snapshot_json TEXT NOT NULL,
          status TEXT NOT NULL,
          payment_mode TEXT NOT NULL,
          wechat_prepay_id TEXT,
          wechat_transaction_id TEXT UNIQUE,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          paid_at TEXT
        );
        CREATE TABLE refunds (
          order_id TEXT PRIMARY KEY REFERENCES orders(id),
          out_refund_no TEXT NOT NULL UNIQUE,
          wechat_refund_id TEXT UNIQUE,
          status TEXT NOT NULL,
          amount INTEGER NOT NULL,
          reason TEXT,
          requested_at TEXT NOT NULL,
          submitted_at TEXT,
          last_checked_at TEXT,
          updated_at TEXT NOT NULL,
          success_at TEXT
        );
        INSERT INTO price_versions (id, version_no, created_by, created_at) VALUES
          (1, 1, 'admin', '2026-09-27T00:00:00.000Z'),
          (2, 2, 'admin', '2026-09-28T00:00:00.000Z');
        PRAGMA user_version = 5;
      `)
      const insertPrice = legacy.prepare(`
        INSERT INTO price_items (price_version_id, customer_type, duration_months, amount)
        VALUES (?, ?, ?, ?)
      `)
      for (const versionId of [1, 2]) {
        for (const customerType of ['merchant', 'resident']) {
          for (const durationMonths of [1, 3, 6, 12]) {
            insertPrice.run(versionId, customerType, durationMonths, versionId === 1 ? 100 : 200)
          }
        }
      }
      const insertOrder = legacy.prepare(`
        INSERT INTO orders (
          id, order_no, client_request_id, openid, customer_type, address, plate_number,
          duration_months, amount, price_version_id, price_version, price_snapshot_json,
          status, payment_mode, created_at, expires_at, updated_at, paid_at
        ) VALUES (?, ?, ?, 'openid', 'resident', '原地址', '新A12345', 1, ?, ?, ?, '{}', ?, 'wechat',
                  '2026-09-28T10:00:00.000Z', '2026-09-28T12:00:00.000Z',
                  '2026-09-28T10:05:00.000Z', ?)
      `)
      for (const [index, status] of ['pending', 'paid', 'refunded', 'closed'].entries()) {
        insertOrder.run(
          `legacy-${index}`, `PF-LEGACY-${index}`, `request-${index}`,
          index < 2 ? 100 : 200, index < 2 ? 1 : 2, index < 2 ? 1 : 2,
          status, status === 'paid' || status === 'refunded' ? '2026-09-28T10:05:00.000Z' : null,
        )
      }
      legacy.prepare(`
        INSERT INTO refunds (
          order_id, out_refund_no, status, amount, requested_at, updated_at, success_at
        ) VALUES ('legacy-2', 'REF-LEGACY-2', 'success', 200,
                  '2026-09-28T11:00:00.000Z', '2026-09-28T11:01:00.000Z', '2026-09-28T11:01:00.000Z')
      `).run()
      legacy.close()

      const config = loadConfig({ NODE_ENV: 'test', PAYMENT_MODE: 'mock', DATABASE_PATH: databasePath })
      for (let startup = 0; startup < 2; startup += 1) {
        const db = openDatabase(config)
        try {
          expect(db.pragma('user_version', { simple: true })).toBe(7)
          expect(db.prepare('SELECT COUNT(*) AS n FROM parking_lots').get()).toEqual({ n: 1 })
          expect(db.prepare('SELECT plate_prefix FROM parking_lots WHERE id = ?').get(INITIAL_PARKING_LOT_ID))
            .toEqual({ plate_prefix: '新A' })
          expect(db.prepare('SELECT COUNT(*) AS n FROM price_versions').get()).toEqual({ n: 2 })
          expect(db.prepare('SELECT COUNT(*) AS n FROM orders').get()).toEqual({ n: 4 })
          expect(db.prepare('SELECT COUNT(*) AS n FROM refunds').get()).toEqual({ n: 1 })
          expect(db.prepare('SELECT DISTINCT parking_lot_id AS id FROM price_versions').all())
            .toEqual([{ id: INITIAL_PARKING_LOT_ID }])
          expect(db.prepare('SELECT DISTINCT parking_lot_id AS id, parking_lot_name_snapshot AS name FROM orders').all())
            .toEqual([{ id: INITIAL_PARKING_LOT_ID, name: INITIAL_PARKING_LOT_NAME }])
          expect(getCurrentPrices(db, INITIAL_PARKING_LOT_ID).version).toBe(2)
          expect(getCurrentPrices(db, INITIAL_PARKING_LOT_ID).items[0].amount).toBe(200)
          expect(getOrderById(db, 'legacy-1')).toMatchObject({ status: 'paid', amount: 100, parkingLotId: INITIAL_PARKING_LOT_ID })
          expect(getOrderById(db, 'legacy-2')).toMatchObject({ status: 'refunded', amount: 200, refund: { status: 'success', amount: 200 } })
        } finally {
          db.close()
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('停用后不接新订单，但已有待支付订单仍可完成并按原场地退款', async () => {
    const app = await createApp({ env: testEnv, databasePath: ':memory:', serveStatic: false })
    try {
      const cookie = await adminCookie(app)
      const second = await createActiveSecondLot(app, cookie)
      const created = await app.inject({
        method: 'POST', url: '/api/public/orders',
        payload: orderPayload(second.id, second.version, 25_000, '新A12345'),
      })
      expect(created.statusCode).toBe(201)
      const { id } = data<{ id: string }>(created)
      const disabled = await app.inject({
        method: 'PATCH', url: `/api/admin/parking-lots/${second.id}`,
        headers: { cookie }, payload: { active: false },
      })
      expect(disabled.statusCode).toBe(200)
      const refused = await app.inject({
        method: 'POST', url: '/api/public/orders',
        payload: orderPayload(second.id, second.version, 25_000, '新A12346'),
      })
      expect(refused.statusCode).toBe(404)
      expect(errorCode(refused)).toBe('PARKING_LOT_UNAVAILABLE')

      const paid = await app.inject({ method: 'POST', url: `/api/public/orders/${id}/mock-pay` })
      expect(paid.statusCode).toBe(200)
      expect(data<{ status: string }>(paid).status).toBe('paid')
      const refunded = await app.inject({
        method: 'POST', url: `/api/admin/orders/${id}/refund`,
        headers: { cookie, 'x-parkfee-admin-action': 'refund' }, payload: { reason: '用户申请' },
      })
      expect(refunded.statusCode).toBe(200)
      expect(data<{ status: string; parkingLotId: string }>(refunded)).toMatchObject({
        status: 'refunded', parkingLotId: second.id,
      })
      const scopedSummary = await app.inject({
        method: 'GET', url: `/api/admin/summary?parkingLotId=${second.id}`,
        headers: { cookie },
      })
      expect(data<{ all: { count: number; amount: number } }>(scopedSummary).all)
        .toEqual({ count: 0, amount: 0 })
      const scopedOrders = await app.inject({
        method: 'GET', url: `/api/admin/orders?parkingLotId=${second.id}&status=refunded`,
        headers: { cookie },
      })
      expect(data<{ total: number }>(scopedOrders).total).toBe(1)
      const csv = await app.inject({
        method: 'GET', url: `/api/admin/orders/export.csv?parkingLotId=${second.id}&status=refunded`,
        headers: { cookie },
      })
      expect(csv.body).toContain('第二停车场')
      expect(csv.body).toContain('新A12345')
    } finally {
      await app.close()
    }
  })

  it('微信授权只接受同一个状态和场地，最新授权覆盖同浏览器旧授权', async () => {
    const app = await createApp({
      env: {
        ...testEnv, PAYMENT_MODE: 'wechat', WECHAT_APP_ID: 'wx-test', WECHAT_APP_SECRET: 'test-secret',
      },
      databasePath: ':memory:', serveStatic: false,
      fetch: (async () => new Response(JSON.stringify({ openid: 'openid' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch,
    })
    try {
      const cookie = await adminCookie(app)
      const firstId = data<Array<{ id: string }>>(await app.inject({ method: 'GET', url: '/api/public/parking-lots' }))[0].id
      const second = await createActiveSecondLot(app, cookie)
      const firstStart = await app.inject({ method: 'GET', url: `/api/public/session?parkingLotId=${firstId}` })
      const secondStart = await app.inject({ method: 'GET', url: `/api/public/session?parkingLotId=${second.id}` })
      const firstState = new URL(data<{ authorizationUrl: string }>(firstStart).authorizationUrl).searchParams.get('state')!
      const secondState = new URL(data<{ authorizationUrl: string }>(secondStart).authorizationUrl).searchParams.get('state')!
      const firstCookie = cookieFrom(firstStart, 'park_oauth_state')
      const secondCookie = cookieFrom(secondStart, 'park_oauth_state')

      const mismatched = await app.inject({
        method: 'GET', url: `/api/public/session?code=code-1&state=${firstState}&parkingLotId=${firstId}`,
        headers: { cookie: secondCookie },
      })
      expect(mismatched.statusCode).toBe(400)
      expect(errorCode(mismatched)).toBe('WECHAT_OAUTH_STATE_INVALID')
      const forgedLot = await app.inject({
        method: 'GET', url: `/api/public/session?code=code-2&state=${secondState}&parkingLotId=${firstId}`,
        headers: { cookie: secondCookie },
      })
      expect(forgedLot.statusCode).toBe(400)
      expect(errorCode(forgedLot)).toBe('WECHAT_OAUTH_STATE_INVALID')
      const valid = await app.inject({
        method: 'GET', url: `/api/public/session?code=code-3&state=${secondState}`,
        headers: { cookie: secondCookie },
      })
      expect(valid.statusCode).toBe(200)
      expect(data<{ resumeParkingLotId: string }>(valid).resumeParkingLotId).toBe(second.id)
      // 每个浏览器只保留最后一次发起的 Cookie；旧请求本身仍不能跨场地恢复。
      const firstValidInIndependentBrowser = await app.inject({
        method: 'GET', url: `/api/public/session?code=code-4&state=${firstState}`,
        headers: { cookie: firstCookie },
      })
      expect(data<{ resumeParkingLotId: string }>(firstValidInIndependentBrowser).resumeParkingLotId).toBe(firstId)
    } finally {
      await app.close()
    }
  })
})
