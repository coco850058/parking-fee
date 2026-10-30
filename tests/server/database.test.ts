import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/server/config.js'
import { getCurrentPrices, getOrderById, INITIAL_PARKING_LOT_ID, INITIAL_PARKING_LOT_NAME, insertOrder, listOrders, listParkingLots, openDatabase, replacePrices } from '../../src/server/database.js'

describe('SQLite 数据一致性', () => {
  it('旧版同类型混合计价时停止下单，管理员统一模式后恢复', () => {
    const db = openDatabase(loadConfig({ NODE_ENV: 'test', PAYMENT_MODE: 'mock', DATABASE_PATH: ':memory:' }))
    try {
      const original = getCurrentPrices(db, INITIAL_PARKING_LOT_ID)
      db.prepare(`
        UPDATE price_items SET mode = 'manual'
        WHERE price_version_id = ? AND customer_type = 'merchant' AND duration_months = 1
      `).run(original.versionId)
      const mixed = getCurrentPrices(db, INITIAL_PARKING_LOT_ID)
      expect(mixed.enabled).toBe(false)
      const repaired = replacePrices(db, mixed.items.map((item) =>
        item.customerType === 'merchant' ? { ...item, mode: 'manual' } : item,
      ), 'admin', '2026-10-30T00:00:00.000Z', INITIAL_PARKING_LOT_ID)
      expect(repaired.enabled).toBe(true)
      expect(repaired.items.filter((item) => item.customerType === 'merchant').every((item) => item.mode === 'manual'))
        .toBe(true)
    } finally {
      db.close()
    }
  })

  it('v10 升级后保留旧手动订单与支付退款关联，新手动订单可不记录时长', () => {
    const directory = mkdtempSync(join(tmpdir(), 'park-fee-null-duration-'))
    const databasePath = join(directory, 'parking.db')
    const legacy = new Database(databasePath)
    legacy.pragma('foreign_keys = ON')
    legacy.exec(`
      CREATE TABLE parking_lots (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, plate_prefix TEXT NOT NULL,
        active INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE price_versions (
        id INTEGER PRIMARY KEY, version_no INTEGER NOT NULL UNIQUE,
        parking_lot_id TEXT REFERENCES parking_lots(id),
        enabled_durations_json TEXT NOT NULL,
        created_by TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE orders (
        id TEXT PRIMARY KEY, order_no TEXT NOT NULL UNIQUE,
        parking_lot_id TEXT REFERENCES parking_lots(id), parking_lot_name_snapshot TEXT,
        client_request_id TEXT NOT NULL, openid TEXT NOT NULL, customer_type TEXT NOT NULL,
        contact_name TEXT, contact_phone TEXT, address TEXT NOT NULL, plate_number TEXT NOT NULL,
        duration_months INTEGER NOT NULL CHECK (duration_months IN (1, 3, 6, 12)),
        amount INTEGER NOT NULL, price_version_id INTEGER NOT NULL REFERENCES price_versions(id),
        price_version INTEGER NOT NULL, price_snapshot_json TEXT NOT NULL,
        status TEXT NOT NULL, payment_mode TEXT NOT NULL, wechat_prepay_id TEXT,
        wechat_transaction_id TEXT UNIQUE, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, paid_at TEXT
      );
      CREATE INDEX idx_orders_created_at ON orders(created_at DESC);
      CREATE TABLE payment_events (
        id INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE,
        order_id TEXT NOT NULL REFERENCES orders(id), event_type TEXT NOT NULL,
        transaction_id TEXT, raw_payload TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE refunds (
        order_id TEXT PRIMARY KEY REFERENCES orders(id), out_refund_no TEXT NOT NULL UNIQUE,
        wechat_refund_id TEXT UNIQUE, status TEXT NOT NULL, amount INTEGER NOT NULL,
        reason TEXT, requested_at TEXT NOT NULL, submitted_at TEXT, last_checked_at TEXT,
        updated_at TEXT NOT NULL, success_at TEXT
      );
      CREATE TABLE refund_events (
        id INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE,
        order_id TEXT NOT NULL REFERENCES orders(id), event_type TEXT NOT NULL,
        raw_payload TEXT NOT NULL, created_at TEXT NOT NULL
      );
      INSERT INTO parking_lots VALUES (
        '${INITIAL_PARKING_LOT_ID}', '${INITIAL_PARKING_LOT_NAME}', '新A', 1,
        '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'
      );
      INSERT INTO price_versions VALUES (
        1, 1, '${INITIAL_PARKING_LOT_ID}', '[1,3,6,12]', 'admin', '2026-10-01T00:00:00.000Z'
      );
      INSERT INTO orders VALUES (
        'old-manual', 'PF-OLD-MANUAL', '${INITIAL_PARKING_LOT_ID}',
        '${INITIAL_PARKING_LOT_NAME}', 'old-request', 'old-openid', 'resident',
        '老用户', '13800138000', '101', '新A12345', 1, 100, 1, 1,
        '{"mode":"manual","durationMonths":1}', 'refunded', 'wechat', NULL,
        'WX-OLD-TRANSACTION', '2026-10-01T00:00:00.000Z',
        '2026-10-01T02:00:00.000Z', '2026-10-01T01:00:00.000Z',
        '2026-10-01T00:05:00.000Z'
      );
      INSERT INTO payment_events VALUES (
        1, 'payment-old', 'old-manual', 'TRANSACTION.SUCCESS',
        'WX-OLD-TRANSACTION', '{}', '2026-10-01T00:05:00.000Z'
      );
      INSERT INTO refunds VALUES (
        'old-manual', 'REF-OLD-MANUAL', NULL, 'success', 100, NULL,
        '2026-10-01T00:30:00.000Z', '2026-10-01T00:31:00.000Z', NULL,
        '2026-10-01T01:00:00.000Z', '2026-10-01T01:00:00.000Z'
      );
      INSERT INTO refund_events VALUES (
        1, 'refund-old', 'old-manual', 'REFUND.SUCCESS', '{}',
        '2026-10-01T01:00:00.000Z'
      );
      PRAGMA user_version = 10;
    `)
    legacy.close()

    const config = loadConfig({ NODE_ENV: 'test', PAYMENT_MODE: 'mock', DATABASE_PATH: databasePath })
    try {
      const upgraded = openDatabase(config)
      try {
        expect(upgraded.pragma('user_version', { simple: true })).toBe(11)
        expect(upgraded.prepare('PRAGMA table_info(orders)').all()).toEqual(
          expect.arrayContaining([expect.objectContaining({ name: 'duration_months', notnull: 0 })]),
        )
        expect(upgraded.prepare('PRAGMA foreign_key_check').all()).toEqual([])
        expect(getOrderById(upgraded, 'old-manual')).toMatchObject({
          durationMonths: 1, amount: 100, pricingMode: 'manual', status: 'refunded',
          refund: { status: 'success', amount: 100 },
        })
        expect(listOrders(upgraded, { durationMonths: 'manual', page: 1, pageSize: 20 }).items.map((item) => item.id))
          .toEqual(['old-manual'])
        expect(listOrders(upgraded, { durationMonths: 1, page: 1, pageSize: 20 }).total).toBe(0)
        for (const table of ['payment_events', 'refunds', 'refund_events']) {
          expect(upgraded.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({ count: 1 })
        }
        const newOrder = insertOrder(upgraded, {
          id: 'new-manual', orderNo: 'PF-NEW-MANUAL', parkingLotId: INITIAL_PARKING_LOT_ID,
          parkingLotName: INITIAL_PARKING_LOT_NAME, clientRequestId: 'new-request', openid: 'new-openid',
          customerType: 'resident', contactName: '新用户', contactPhone: '13800138001',
          address: '102', plateNumber: '新A12346', durationMonths: null, amount: 200,
          pricingMode: 'manual', priceVersion: 1, priceVersionId: 1, paymentMode: 'mock',
          now: '2026-10-30T00:00:00.000Z', expiresAt: '2026-10-30T02:00:00.000Z',
        })
        expect(newOrder.durationMonths).toBeNull()
        expect(upgraded.prepare('SELECT duration_months FROM orders WHERE id = ?').get('new-manual'))
          .toEqual({ duration_months: null })
      } finally {
        upgraded.close()
      }
      const reopened = openDatabase(config)
      try {
        expect(reopened.prepare('PRAGMA foreign_key_check').all()).toEqual([])
        expect(getOrderById(reopened, 'old-manual').durationMonths).toBe(1)
        expect(getOrderById(reopened, 'new-manual').durationMonths).toBeNull()
      } finally {
        reopened.close()
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('手动金额模式与固定价可跨重启保留，旧价版本仍为固定模式', () => {
    const directory = mkdtempSync(join(tmpdir(), 'park-fee-pricing-mode-'))
    const databasePath = join(directory, 'parking.db')
    const config = loadConfig({ NODE_ENV: 'test', PAYMENT_MODE: 'mock', DATABASE_PATH: databasePath })
    try {
      const initial = openDatabase(config)
      const before = getCurrentPrices(initial, INITIAL_PARKING_LOT_ID)
      const next = replacePrices(initial, before.items.map((item) =>
        item.customerType === 'merchant'
          ? { ...item, amount: 0, mode: 'manual' }
          : item,
      ), 'test', '2026-10-30T00:00:00.000Z', INITIAL_PARKING_LOT_ID)
      expect(next.enabled).toBe(true)
      initial.close()

      const reopened = openDatabase(config)
      try {
        expect(reopened.pragma('user_version', { simple: true })).toBe(11)
        expect(getCurrentPrices(reopened, INITIAL_PARKING_LOT_ID).items.find((item) =>
          item.customerType === 'merchant' && item.durationMonths === 1,
        )).toMatchObject({ amount: 0, mode: 'manual' })
        expect(reopened.prepare('SELECT mode FROM price_items WHERE price_version_id = 1 AND customer_type = ? AND duration_months = 1')
          .get('merchant')).toEqual({ mode: 'fixed' })
      } finally {
        reopened.close()
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('将 v1 订单无损迁移并回填幂等键与两小时失效时间', () => {
    const directory = mkdtempSync(join(tmpdir(), 'park-fee-migration-'))
    const databasePath = join(directory, 'parking.db')
    const legacy = new Database(databasePath)
    legacy.exec(`
      CREATE TABLE price_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version_no INTEGER NOT NULL UNIQUE,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO price_versions (id, version_no, created_by, created_at)
      VALUES (1, 1, 'legacy', '2026-09-22T00:00:00.000Z');

      CREATE TABLE orders (
        id TEXT PRIMARY KEY,
        order_no TEXT NOT NULL UNIQUE,
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
        updated_at TEXT NOT NULL,
        paid_at TEXT
      );
      INSERT INTO orders (
        id, order_no, openid, customer_type, address, plate_number, duration_months,
        amount, price_version_id, price_version, price_snapshot_json, status,
        payment_mode, created_at, updated_at
      ) VALUES (
        'legacy-order-id', 'PF-LEGACY-1', 'legacy-openid', 'resident', '旧地址',
        '沪A12345', 1, 8000, 1, 1, '{}', 'pending', 'mock',
        '2026-09-22T00:00:00.000Z', '2026-09-22T00:00:00.000Z'
      );
    `)
    legacy.close()

    const migrated = openDatabase(
      loadConfig({
        NODE_ENV: 'test',
        PAYMENT_MODE: 'mock',
        DATABASE_PATH: databasePath,
      }),
    )
    try {
      const order = getOrderById(migrated, 'legacy-order-id')
      expect(order.clientRequestId).toBe('legacy-legacy-order-id')
      expect(order.expiresAt).toBe('2026-09-22T02:00:00.000Z')
      expect(order.parkingLotId).toBe(INITIAL_PARKING_LOT_ID)
      expect(order.parkingLotName).toBe(INITIAL_PARKING_LOT_NAME)
      expect(order.contactName).toBeNull()
      expect(order.contactPhone).toBeNull()
      expect(order.address).toBe('旧地址')
      expect(migrated.prepare('SELECT parking_lot_id FROM price_versions WHERE id = 1').get())
        .toEqual({ parking_lot_id: INITIAL_PARKING_LOT_ID })
      expect(migrated.pragma('user_version', { simple: true })).toBe(11)
      expect(migrated.prepare("SELECT COUNT(*) AS count FROM price_items WHERE mode <> 'fixed'").get())
        .toEqual({ count: 0 })
      expect(migrated.prepare('SELECT enabled_durations_json FROM price_versions WHERE id = 1').get())
        .toEqual({ enabled_durations_json: '[1,3,6,12]' })
      expect(listParkingLots(migrated)[0].platePrefix).toBe('新A')
      expect(migrated.prepare("SELECT name FROM sqlite_master WHERE name = 'refunds'").get()).toBeTruthy()
      expect(migrated.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_orders_status_paid_at'").get()).toBeTruthy()
    } finally {
      migrated.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('现有多停车场数据库升级时给每个场地回填默认前缀，不改变场地状态', () => {
    const directory = mkdtempSync(join(tmpdir(), 'park-fee-prefix-migration-'))
    const databasePath = join(directory, 'parking.db')
    const legacy = new Database(databasePath)
    const secondId = '00000000-0000-4000-8000-000000000002'
    legacy.exec(`
      CREATE TABLE parking_lots (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        active INTEGER NOT NULL CHECK (active IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO parking_lots (id, name, active, created_at, updated_at) VALUES
        ('${INITIAL_PARKING_LOT_ID}', '${INITIAL_PARKING_LOT_NAME}', 1, '2026-01-01', '2026-01-01'),
        ('${secondId}', '旧备用停车场', 0, '2026-02-01', '2026-02-01');
      PRAGMA user_version = 6;
    `)
    legacy.close()
    const migrated = openDatabase(loadConfig({ NODE_ENV: 'test', PAYMENT_MODE: 'mock', DATABASE_PATH: databasePath }))
    try {
      expect(listParkingLots(migrated, true).map(({ id, name, active, platePrefix }) => ({ id, name, active, platePrefix })))
        .toEqual([
          { id: INITIAL_PARKING_LOT_ID, name: INITIAL_PARKING_LOT_NAME, active: true, platePrefix: '新A' },
          { id: secondId, name: '旧备用停车场', active: false, platePrefix: '新A' },
        ])
      expect(migrated.pragma('user_version', { simple: true })).toBe(11)
    } finally {
      migrated.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('生产使用 FULL 同步级别，测试环境保持 NORMAL', () => {
    const development = openDatabase(
      loadConfig({ NODE_ENV: 'test', PAYMENT_MODE: 'mock', DATABASE_PATH: ':memory:' }),
    )
    const production = openDatabase(
      loadConfig({
        NODE_ENV: 'production',
        PAYMENT_MODE: 'mock',
        JWT_SECRET: 'production-secret-with-more-than-32-characters',
        ADMIN_PASSWORD_HASH: '$2b$12$not-used-in-this-test-but-required',
        DATABASE_PATH: ':memory:',
      }),
    )
    try {
      expect(development.pragma('synchronous', { simple: true })).toBe(1)
      expect(production.pragma('synchronous', { simple: true })).toBe(2)
    } finally {
      development.close()
      production.close()
    }
  })
})
