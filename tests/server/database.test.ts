import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/server/config.js'
import { getOrderById, INITIAL_PARKING_LOT_ID, INITIAL_PARKING_LOT_NAME, listParkingLots, openDatabase } from '../../src/server/database.js'

describe('SQLite 数据一致性', () => {
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
      expect(migrated.prepare('SELECT parking_lot_id FROM price_versions WHERE id = 1').get())
        .toEqual({ parking_lot_id: INITIAL_PARKING_LOT_ID })
      expect(migrated.pragma('user_version', { simple: true })).toBe(7)
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
      expect(migrated.pragma('user_version', { simple: true })).toBe(7)
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
