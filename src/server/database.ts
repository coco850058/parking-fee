import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import type { AppConfig } from './config.js'
import {
  customerTypes,
  DEFAULT_PLATE_PREFIX,
  durationOptions,
  type CustomerType,
  type DurationMonths,
  type OrderRecord,
  type OrderStatus,
  type PriceItem,
  type PriceList,
  type RefundStatus,
} from './domain.js'
import { AppError } from './errors.js'
import { shanghaiDateParts, shanghaiDayStartIso } from './dates.js'

export type ParkingDatabase = Database.Database

export const INITIAL_PARKING_LOT_ID = '00000000-0000-4000-8000-000000000001'
export const INITIAL_PARKING_LOT_NAME = '得源峰内部停车场'

export interface ParkingLot {
  id: string
  name: string
  platePrefix: string
  active: boolean
  createdAt: string
  updatedAt: string
}

interface ParkingLotRow {
  id: string
  name: string
  plate_prefix: string
  active: number
  created_at: string
  updated_at: string
}

interface OrderRow {
  id: string
  order_no: string
  parking_lot_id: string
  parking_lot_name_snapshot: string
  client_request_id: string
  openid: string
  customer_type: CustomerType
  address: string
  plate_number: string
  duration_months: DurationMonths
  amount: number
  price_version: number
  status: OrderStatus
  payment_mode: 'mock' | 'wechat'
  wechat_transaction_id: string | null
  created_at: string
  expires_at: string
  updated_at: string
  paid_at: string | null
  refund_status: RefundStatus | null
  refund_amount: number | null
  refund_requested_at: string | null
  refund_success_at: string | null
}

interface RefundRow {
  order_id: string
  out_refund_no: string
  wechat_refund_id: string | null
  status: RefundStatus
  amount: number
  reason: string | null
  requested_at: string
  success_at: string | null
  submitted_at: string | null
}

export interface RefundIntent {
  orderId: string
  outRefundNo: string
  wechatRefundId: string | null
  status: RefundStatus
  amount: number
  reason: string | null
  requestedAt: string
  successAt: string | null
  submittedAt: string | null
}

const ORDER_SELECT = `
  SELECT o.*, r.status AS refund_status, r.amount AS refund_amount,
         r.requested_at AS refund_requested_at, r.success_at AS refund_success_at
  FROM orders o LEFT JOIN refunds r ON r.order_id = o.id
`

export interface NewOrder {
  id: string
  orderNo: string
  parkingLotId: string
  parkingLotName: string
  clientRequestId: string
  openid: string
  customerType: CustomerType
  address: string
  plateNumber: string
  durationMonths: DurationMonths
  amount: number
  priceVersion: number
  priceVersionId: number
  paymentMode: 'mock' | 'wechat'
  now: string
  expiresAt: string
}

export interface OrderFilters {
  parkingLotId?: string
  from?: string
  to?: string
  status?: OrderStatus
  customerType?: CustomerType
  durationMonths?: DurationMonths
  keyword?: string
  page: number
  pageSize: number
}

export interface OrderList {
  items: OrderRecord[]
  total: number
  page: number
  pageSize: number
}

export function openDatabase(config: AppConfig): ParkingDatabase {
  if (config.databasePath !== ':memory:') {
    mkdirSync(dirname(config.databasePath), { recursive: true })
  }
  const db = new Database(config.databasePath)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  db.pragma('foreign_keys = ON')
  // 缴费数据优先保证掉电一致性；开发/测试仍用 NORMAL 保持启动和测试速度。
  db.pragma(`synchronous = ${config.isProduction ? 'FULL' : 'NORMAL'}`)
  migrate(db)
  seedInitialPrices(db, config.isProduction)
  return db
}

function migrate(db: ParkingDatabase): void {
  db.transaction(() => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS parking_lots (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      plate_prefix TEXT NOT NULL DEFAULT '新A',
      active INTEGER NOT NULL CHECK (active IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS price_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version_no INTEGER NOT NULL UNIQUE,
      parking_lot_id TEXT REFERENCES parking_lots(id),
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS price_items (
      price_version_id INTEGER NOT NULL REFERENCES price_versions(id) ON DELETE CASCADE,
      customer_type TEXT NOT NULL CHECK (customer_type IN ('merchant', 'resident')),
      duration_months INTEGER NOT NULL CHECK (duration_months IN (1, 3, 6, 12)),
      amount INTEGER NOT NULL CHECK (amount >= 0),
      PRIMARY KEY (price_version_id, customer_type, duration_months)
    );

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      order_no TEXT NOT NULL UNIQUE,
      parking_lot_id TEXT REFERENCES parking_lots(id),
      parking_lot_name_snapshot TEXT,
      client_request_id TEXT NOT NULL,
      openid TEXT NOT NULL,
      customer_type TEXT NOT NULL CHECK (customer_type IN ('merchant', 'resident')),
      address TEXT NOT NULL,
      plate_number TEXT NOT NULL,
      duration_months INTEGER NOT NULL CHECK (duration_months IN (1, 3, 6, 12)),
      amount INTEGER NOT NULL CHECK (amount >= 0),
      price_version_id INTEGER NOT NULL REFERENCES price_versions(id),
      price_version INTEGER NOT NULL,
      price_snapshot_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'closed', 'refunded')),
      payment_mode TEXT NOT NULL CHECK (payment_mode IN ('mock', 'wechat')),
      wechat_prepay_id TEXT,
      wechat_transaction_id TEXT UNIQUE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      paid_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_orders_status_created_at ON orders(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_orders_plate_number ON orders(plate_number);
    CREATE INDEX IF NOT EXISTS idx_orders_openid ON orders(openid);

    CREATE TABLE IF NOT EXISTS payment_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      order_id TEXT NOT NULL REFERENCES orders(id),
      event_type TEXT NOT NULL,
      transaction_id TEXT,
      raw_payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_payment_events_order ON payment_events(order_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT,
      details_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS refunds (
      order_id TEXT PRIMARY KEY REFERENCES orders(id),
      out_refund_no TEXT NOT NULL UNIQUE,
      wechat_refund_id TEXT UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('requesting', 'processing', 'success', 'closed', 'abnormal')),
      amount INTEGER NOT NULL CHECK (amount > 0),
      reason TEXT,
      requested_at TEXT NOT NULL,
      submitted_at TEXT,
      last_checked_at TEXT,
      updated_at TEXT NOT NULL,
      success_at TEXT
    );

    CREATE TABLE IF NOT EXISTS refund_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      order_id TEXT NOT NULL REFERENCES orders(id),
      event_type TEXT NOT NULL,
      raw_payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_orders_openid_paid_at
      ON orders(openid, status, paid_at DESC);
    CREATE INDEX IF NOT EXISTS idx_orders_status_paid_at
      ON orders(status, paid_at DESC);

  `)

  // v1 数据库没有幂等请求号和过期时间。SQLite 添加 NOT NULL 列需要默认值，
  // 因此先添加可空列，再一次性回填；所有新写入仍由应用层保证非空。
  const columns = db.prepare('PRAGMA table_info(orders)').all() as Array<{ name: string }>
  const names = new Set(columns.map((column) => column.name))
  if (!names.has('client_request_id')) {
    db.exec('ALTER TABLE orders ADD COLUMN client_request_id TEXT')
  }
  if (!names.has('expires_at')) {
    db.exec('ALTER TABLE orders ADD COLUMN expires_at TEXT')
  }
  if (!names.has('parking_lot_id')) {
    db.exec('ALTER TABLE orders ADD COLUMN parking_lot_id TEXT REFERENCES parking_lots(id)')
  }
  if (!names.has('parking_lot_name_snapshot')) {
    db.exec('ALTER TABLE orders ADD COLUMN parking_lot_name_snapshot TEXT')
  }
  const priceColumns = db.prepare('PRAGMA table_info(price_versions)').all() as Array<{ name: string }>
  if (!priceColumns.some((column) => column.name === 'parking_lot_id')) {
    db.exec('ALTER TABLE price_versions ADD COLUMN parking_lot_id TEXT REFERENCES parking_lots(id)')
  }
  const parkingLotColumns = db.prepare('PRAGMA table_info(parking_lots)').all() as Array<{ name: string }>
  if (!parkingLotColumns.some((column) => column.name === 'plate_prefix')) {
    db.exec("ALTER TABLE parking_lots ADD COLUMN plate_prefix TEXT NOT NULL DEFAULT '新A'")
  }
  const refundColumns = db.prepare('PRAGMA table_info(refunds)').all() as Array<{ name: string }>
  if (!refundColumns.some((column) => column.name === 'last_checked_at')) {
    db.exec('ALTER TABLE refunds ADD COLUMN last_checked_at TEXT')
  }
  const migratedAt = new Date().toISOString()
  db.prepare(`
    INSERT OR IGNORE INTO parking_lots (id, name, active, created_at, updated_at)
    VALUES (?, ?, 1, ?, ?)
  `).run(INITIAL_PARKING_LOT_ID, INITIAL_PARKING_LOT_NAME, migratedAt, migratedAt)
  db.exec(`
    UPDATE price_versions
    SET parking_lot_id = '${INITIAL_PARKING_LOT_ID}'
    WHERE parking_lot_id IS NULL;

    UPDATE orders
    SET parking_lot_id = '${INITIAL_PARKING_LOT_ID}'
    WHERE parking_lot_id IS NULL;

    UPDATE orders
    SET parking_lot_name_snapshot = '${INITIAL_PARKING_LOT_NAME}'
    WHERE parking_lot_name_snapshot IS NULL OR parking_lot_name_snapshot = '';

    UPDATE orders
    SET client_request_id = 'legacy-' || id
    WHERE client_request_id IS NULL OR client_request_id = '';

    UPDATE orders
    SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+2 hours')
    WHERE expires_at IS NULL OR expires_at = '';

    CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_openid_client_request
      ON orders(openid, client_request_id);

    CREATE INDEX IF NOT EXISTS idx_price_versions_lot_version
      ON price_versions(parking_lot_id, version_no DESC);
    CREATE INDEX IF NOT EXISTS idx_orders_lot_created_at
      ON orders(parking_lot_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_orders_lot_status_paid_at
      ON orders(parking_lot_id, status, paid_at DESC);

    PRAGMA user_version = 7;
  `)
  })()
}

function seedInitialPrices(db: ParkingDatabase, production: boolean): void {
  const count = db.prepare('SELECT COUNT(*) AS count FROM price_versions').get() as { count: number }
  if (count.count > 0) return

  const demo: Record<CustomerType, Record<DurationMonths, number>> = {
    merchant: { 1: 10_000, 3: 28_000, 6: 54_000, 12: 100_000 },
    resident: { 1: 8_000, 3: 22_000, 6: 42_000, 12: 80_000 },
  }
  const createdAt = new Date().toISOString()
  db.transaction(() => {
    const version = db
      .prepare('INSERT INTO price_versions (version_no, parking_lot_id, created_by, created_at) VALUES (1, ?, ?, ?)')
      .run(INITIAL_PARKING_LOT_ID, 'system', createdAt)
    const insert = db.prepare(`
      INSERT INTO price_items (price_version_id, customer_type, duration_months, amount)
      VALUES (?, ?, ?, ?)
    `)
    for (const customerType of customerTypes) {
      for (const duration of durationOptions) {
        insert.run(version.lastInsertRowid, customerType, duration, production ? 0 : demo[customerType][duration])
      }
    }
  })()
}

function mapParkingLot(row: ParkingLotRow): ParkingLot {
  return {
    id: row.id,
    name: row.name,
    platePrefix: row.plate_prefix,
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function listParkingLots(db: ParkingDatabase, includeInactive = false): ParkingLot[] {
  const rows = db.prepare(`
    SELECT * FROM parking_lots ${includeInactive ? '' : 'WHERE active = 1'}
    ORDER BY created_at, id
  `).all() as ParkingLotRow[]
  return rows.map(mapParkingLot)
}

export function getParkingLot(db: ParkingDatabase, id: string, requireActive = false): ParkingLot {
  const row = db.prepare('SELECT * FROM parking_lots WHERE id = ?').get(id) as ParkingLotRow | undefined
  if (!row) throw new AppError(404, 'PARKING_LOT_NOT_FOUND', '停车场不存在')
  if (requireActive && row.active !== 1) {
    throw new AppError(404, 'PARKING_LOT_UNAVAILABLE', '该停车场暂不可缴费，请重新扫码')
  }
  return mapParkingLot(row)
}

export function resolvePublicParkingLot(db: ParkingDatabase, id?: string): ParkingLot {
  if (id) return getParkingLot(db, id, true)
  const active = listParkingLots(db)
  if (active.length === 0) {
    throw new AppError(409, 'PARKING_LOT_UNAVAILABLE', '暂无可缴费的停车场')
  }
  if (active.length > 1) {
    throw new AppError(400, 'PARKING_LOT_REQUIRED', '请选择停车场后再缴费')
  }
  return active[0]
}

export function createParkingLot(
  db: ParkingDatabase,
  name: string,
  actor: string,
  now: string,
  platePrefix = DEFAULT_PLATE_PREFIX,
): ParkingLot {
  const id = randomUUID()
  return db.transaction(() => {
    const existing = db.prepare('SELECT id FROM parking_lots WHERE name = ? COLLATE NOCASE').get(name)
    if (existing) throw new AppError(409, 'PARKING_LOT_NAME_EXISTS', '停车场名称已存在')
    db.prepare(`
      INSERT INTO parking_lots (id, name, plate_prefix, active, created_at, updated_at)
      VALUES (?, ?, ?, 0, ?, ?)
    `).run(id, name, platePrefix, now, now)
    const current = db.prepare('SELECT COALESCE(MAX(version_no), 0) AS version FROM price_versions').get() as {
      version: number
    }
    const version = db.prepare(`
      INSERT INTO price_versions (version_no, parking_lot_id, created_by, created_at)
      VALUES (?, ?, ?, ?)
    `).run(current.version + 1, id, actor, now)
    const insert = db.prepare(`
      INSERT INTO price_items (price_version_id, customer_type, duration_months, amount)
      VALUES (?, ?, ?, 0)
    `)
    for (const type of customerTypes) {
      for (const duration of durationOptions) insert.run(version.lastInsertRowid, type, duration)
    }
    db.prepare(`
      INSERT INTO audit_logs (actor, action, target_type, target_id, details_json, created_at)
      VALUES (?, 'parking_lot.create', 'parking_lot', ?, ?, ?)
    `).run(actor, id, JSON.stringify({ name, platePrefix }), now)
    return getParkingLot(db, id)
  })()
}

export function updateParkingLot(
  db: ParkingDatabase,
  id: string,
  changes: { name?: string; platePrefix?: string; active?: boolean },
  actor: string,
  now: string,
): ParkingLot {
  return db.transaction(() => {
    const previous = getParkingLot(db, id)
    const name = changes.name ?? previous.name
    const platePrefix = changes.platePrefix ?? previous.platePrefix
    const active = changes.active ?? previous.active
    if (name.toLocaleLowerCase() !== previous.name.toLocaleLowerCase()) {
      const duplicate = db.prepare('SELECT id FROM parking_lots WHERE name = ? COLLATE NOCASE AND id != ?')
        .get(name, id)
      if (duplicate) throw new AppError(409, 'PARKING_LOT_NAME_EXISTS', '停车场名称已存在')
    }
    if (active && !previous.active && !getCurrentPrices(db, id).enabled) {
      throw new AppError(409, 'PARKING_LOT_PRICE_NOT_CONFIGURED', '请先配置全部非零缴费标准再启用停车场')
    }
    db.prepare('UPDATE parking_lots SET name = ?, plate_prefix = ?, active = ?, updated_at = ? WHERE id = ?')
      .run(name, platePrefix, Number(active), now, id)
    db.prepare(`
      INSERT INTO audit_logs (actor, action, target_type, target_id, details_json, created_at)
      VALUES (?, 'parking_lot.update', 'parking_lot', ?, ?, ?)
    `).run(actor, id, JSON.stringify({ previous, name, platePrefix, active }), now)
    return getParkingLot(db, id)
  })()
}

export function getCurrentPrices(db: ParkingDatabase, parkingLotId?: string): PriceList & { versionId: number } {
  const id = parkingLotId ?? resolvePublicParkingLot(db).id
  getParkingLot(db, id)
  const version = db
    .prepare('SELECT id, version_no FROM price_versions WHERE parking_lot_id = ? ORDER BY version_no DESC LIMIT 1')
    .get(id) as { id: number; version_no: number } | undefined
  if (!version) throw new AppError(500, 'PRICE_NOT_CONFIGURED', '价格尚未配置')
  const rows = db
    .prepare(`
      SELECT customer_type, duration_months, amount
      FROM price_items
      WHERE price_version_id = ?
      ORDER BY CASE customer_type WHEN 'merchant' THEN 1 ELSE 2 END, duration_months
    `)
    .all(version.id) as Array<{
    customer_type: CustomerType
    duration_months: DurationMonths
    amount: number
  }>
  const items = rows.map((row) => ({
    customerType: row.customer_type,
    durationMonths: row.duration_months,
    amount: row.amount,
  }))
  return {
    versionId: version.id,
    version: version.version_no,
    enabled: items.length === 8 && items.every((item) => item.amount > 0),
    items,
  }
}

function assertCompletePriceMatrix(items: PriceItem[]): void {
  const received = new Set(items.map((item) => `${item.customerType}:${item.durationMonths}`))
  const expected = customerTypes.flatMap((type) =>
    durationOptions.map((duration) => `${type}:${duration}`),
  )
  if (received.size !== expected.length || expected.some((key) => !received.has(key))) {
    throw new AppError(400, 'INVALID_PRICE_MATRIX', '必须为两类用户配置全部四种时长的价格')
  }
}

export function replacePrices(
  db: ParkingDatabase,
  items: PriceItem[],
  actor: string,
  now: string,
  parkingLotId?: string,
): PriceList {
  const lot = parkingLotId ? getParkingLot(db, parkingLotId) : resolvePublicParkingLot(db)
  assertCompletePriceMatrix(items)
  db.transaction(() => {
    const current = db.prepare('SELECT COALESCE(MAX(version_no), 0) AS version FROM price_versions').get() as {
      version: number
    }
    const nextVersion = current.version + 1
    const version = db
      .prepare('INSERT INTO price_versions (version_no, parking_lot_id, created_by, created_at) VALUES (?, ?, ?, ?)')
      .run(nextVersion, lot.id, actor, now)
    const insert = db.prepare(`
      INSERT INTO price_items (price_version_id, customer_type, duration_months, amount)
      VALUES (?, ?, ?, ?)
    `)
    for (const item of items) {
      insert.run(version.lastInsertRowid, item.customerType, item.durationMonths, item.amount)
    }
    db.prepare(`
      INSERT INTO audit_logs (actor, action, target_type, target_id, details_json, created_at)
      VALUES (?, 'prices.update', 'price_version', ?, ?, ?)
    `).run(actor, String(nextVersion), JSON.stringify({ parkingLotId: lot.id, items }), now)
  })()
  const { versionId: _versionId, ...prices } = getCurrentPrices(db, lot.id)
  return prices
}

export function findPrice(
  prices: PriceList,
  customerType: CustomerType,
  durationMonths: DurationMonths,
): number {
  if (!prices.enabled) {
    throw new AppError(409, 'PAYMENT_DISABLED', '缴费通道暂未开放')
  }
  const item = prices.items.find(
    (candidate) =>
      candidate.customerType === customerType && candidate.durationMonths === durationMonths,
  )
  if (!item || item.amount <= 0) {
    throw new AppError(409, 'PAYMENT_DISABLED', '该类型和时长暂未开放缴费')
  }
  return item.amount
}

export function insertOrder(db: ParkingDatabase, order: NewOrder): OrderRecord {
  db.prepare(`
    INSERT INTO orders (
      id, order_no, parking_lot_id, parking_lot_name_snapshot, client_request_id, openid,
      customer_type, address, plate_number, duration_months,
      amount, price_version_id, price_version, price_snapshot_json, status,
      payment_mode, created_at, expires_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
  `).run(
    order.id,
    order.orderNo,
    order.parkingLotId,
    order.parkingLotName,
    order.clientRequestId,
    order.openid,
    order.customerType,
    order.address,
    order.plateNumber,
    order.durationMonths,
    order.amount,
    order.priceVersionId,
    order.priceVersion,
    JSON.stringify({
      parkingLotId: order.parkingLotId,
      parkingLotName: order.parkingLotName,
      version: order.priceVersion,
      customerType: order.customerType,
      durationMonths: order.durationMonths,
      amount: order.amount,
    }),
    order.paymentMode,
    order.now,
    order.expiresAt,
    order.now,
  )
  return getOrderById(db, order.id)
}

export function savePrepayId(db: ParkingDatabase, orderId: string, prepayId: string, now: string): boolean {
  const result = db.prepare(`
    UPDATE orders SET wechat_prepay_id = ?, updated_at = ?
    WHERE id = ? AND status = 'pending' AND expires_at > ?
  `).run(prepayId, now, orderId, now)
  return result.changes === 1
}

export function getPrepayId(db: ParkingDatabase, orderId: string): string | null {
  const row = db
    .prepare('SELECT wechat_prepay_id FROM orders WHERE id = ?')
    .get(orderId) as { wechat_prepay_id: string | null } | undefined
  return row?.wechat_prepay_id ?? null
}

function mapOrder(row: OrderRow): OrderRecord {
  return {
    id: row.id,
    orderNo: row.order_no,
    parkingLotId: row.parking_lot_id,
    parkingLotName: row.parking_lot_name_snapshot,
    clientRequestId: row.client_request_id,
    openid: row.openid,
    customerType: row.customer_type,
    address: row.address,
    plateNumber: row.plate_number,
    durationMonths: row.duration_months,
    amount: row.amount,
    priceVersion: row.price_version,
    status: row.status,
    paymentMode: row.payment_mode,
    transactionId: row.wechat_transaction_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    updatedAt: row.updated_at,
    paidAt: row.paid_at,
    refund: row.refund_status && row.refund_amount !== null && row.refund_requested_at
      ? {
          status: row.refund_status,
          amount: row.refund_amount,
          requestedAt: row.refund_requested_at,
          successAt: row.refund_success_at,
        }
      : null,
  }
}

export function getOrderByClientRequestId(
  db: ParkingDatabase,
  openid: string,
  clientRequestId: string,
): OrderRecord | null {
  const row = db
    .prepare(`${ORDER_SELECT} WHERE o.openid = ? AND o.client_request_id = ?`)
    .get(openid, clientRequestId) as OrderRow | undefined
  return row ? mapOrder(row) : null
}

/**
 * 将已超过本地/微信统一失效时间的待支付单原子关闭，并清除不可再复用的 prepay_id。
 */
export function expirePendingOrders(db: ParkingDatabase, now: string): number {
  const result = db.prepare(`
    UPDATE orders
    SET status = 'closed', wechat_prepay_id = NULL, updated_at = ?
    WHERE status = 'pending' AND expires_at <= ?
  `).run(now, now)
  return result.changes
}

export function getOrderById(db: ParkingDatabase, id: string): OrderRecord {
  const row = db.prepare(`${ORDER_SELECT} WHERE o.id = ?`).get(id) as OrderRow | undefined
  if (!row) throw new AppError(404, 'ORDER_NOT_FOUND', '订单不存在')
  return mapOrder(row)
}

export function getOrderByNo(db: ParkingDatabase, orderNo: string): OrderRecord {
  const row = db.prepare(`${ORDER_SELECT} WHERE o.order_no = ?`).get(orderNo) as OrderRow | undefined
  if (!row) throw new AppError(404, 'ORDER_NOT_FOUND', '订单不存在')
  return mapOrder(row)
}

export function listPaymentHistory(
  db: ParkingDatabase,
  openid: string,
  page: number,
  pageSize: number,
): OrderList {
  const count = db.prepare(`
    SELECT COUNT(*) AS count FROM orders
    WHERE openid = ? AND status IN ('paid', 'refunded')
  `).get(openid) as { count: number }
  const rows = db.prepare(`
    ${ORDER_SELECT}
    WHERE o.openid = ? AND o.status IN ('paid', 'refunded')
    ORDER BY o.paid_at DESC, o.created_at DESC LIMIT ? OFFSET ?
  `).all(openid, pageSize, (page - 1) * pageSize) as OrderRow[]
  return { items: rows.map(mapOrder), total: count.count, page, pageSize }
}

function mapRefund(row: RefundRow): RefundIntent {
  return {
    orderId: row.order_id,
    outRefundNo: row.out_refund_no,
    wechatRefundId: row.wechat_refund_id,
    status: row.status,
    amount: row.amount,
    reason: row.reason,
    requestedAt: row.requested_at,
    successAt: row.success_at,
    submittedAt: row.submitted_at,
  }
}

export function getRefundIntent(db: ParkingDatabase, orderId: string): RefundIntent | null {
  const row = db.prepare('SELECT * FROM refunds WHERE order_id = ?').get(orderId) as RefundRow | undefined
  return row ? mapRefund(row) : null
}

/** 一单只生成一个退款单号；数据库提交成功后方可发出退款请求。 */
export function createRefundIntent(
  db: ParkingDatabase,
  orderId: string,
  reason: string | undefined,
  now: string,
): { refund: RefundIntent; created: boolean } {
  return db.transaction(() => {
    const existing = getRefundIntent(db, orderId)
    if (existing) return { refund: existing, created: false }
    const order = getOrderById(db, orderId)
    if (order.status !== 'paid' || !order.transactionId || order.amount <= 0) {
      throw new AppError(409, 'ORDER_NOT_REFUNDABLE', '仅已支付订单可申请退款')
    }
    const outRefundNo = `R${order.id.replaceAll('-', '').toUpperCase()}`
    db.prepare(`
      INSERT INTO refunds (
        order_id, out_refund_no, status, amount, reason, requested_at, updated_at
      ) VALUES (?, ?, 'requesting', ?, ?, ?, ?)
    `).run(orderId, outRefundNo, order.amount, reason ?? null, now, now)
    db.prepare(`
      INSERT INTO audit_logs (actor, action, target_type, target_id, details_json, created_at)
      VALUES ('admin', 'refund.request', 'order', ?, ?, ?)
    `).run(orderId, JSON.stringify({ outRefundNo, amount: order.amount, reason: reason ?? null }), now)
    return { refund: getRefundIntent(db, orderId)!, created: true }
  })()
}

/** 崩溃/网络不确定时，至少隔一分钟才允许用原单号重试。 */
export function claimRefundSubmission(db: ParkingDatabase, orderId: string, now: string): boolean {
  const cutoff = new Date(new Date(now).getTime() - 60_000).toISOString()
  const result = db.prepare(`
    UPDATE refunds SET submitted_at = ?, updated_at = ?
    WHERE order_id = ? AND status = 'requesting'
      AND (submitted_at IS NULL OR submitted_at <= ?)
  `).run(now, now, orderId, cutoff)
  return result.changes === 1
}

/** 后台只读对账的候选集；每轮限量且按最久未核查优先。 */
export function listRefundIntentsForPoll(
  db: ParkingDatabase,
  now: string,
  limit: number,
): RefundIntent[] {
  const cutoff = new Date(new Date(now).getTime() - 60_000).toISOString()
  const rows = db.prepare(`
    SELECT * FROM refunds
    WHERE status IN ('requesting', 'processing', 'abnormal')
      AND requested_at <= ?
      AND (last_checked_at IS NULL OR last_checked_at <= ?)
    ORDER BY COALESCE(last_checked_at, requested_at) ASC
    LIMIT ?
  `).all(cutoff, cutoff, limit) as RefundRow[]
  return rows.map(mapRefund)
}

export function claimRefundPoll(db: ParkingDatabase, orderId: string, now: string): boolean {
  const cutoff = new Date(new Date(now).getTime() - 60_000).toISOString()
  const result = db.prepare(`
    UPDATE refunds SET last_checked_at = ?
    WHERE order_id = ? AND status IN ('requesting', 'processing', 'abnormal')
      AND requested_at <= ?
      AND (last_checked_at IS NULL OR last_checked_at <= ?)
  `).run(now, orderId, cutoff, cutoff)
  return result.changes === 1
}

export function auditRefundError(
  db: ParkingDatabase,
  orderId: string,
  action: string,
  code: string,
  now: string,
): void {
  db.prepare(`
    INSERT INTO audit_logs (actor, action, target_type, target_id, details_json, created_at)
    VALUES ('system', ?, 'order', ?, ?, ?)
  `).run(action, orderId, JSON.stringify({ code }), now)
}

export function applyRefundResult(
  db: ParkingDatabase,
  input: {
    orderId: string
    status: Exclude<RefundStatus, 'requesting'>
    wechatRefundId: string
    successAt?: string | null
    eventId?: string
    eventType: string
    rawPayload: string
    actor: string
    now: string
  },
): OrderRecord {
  return db.transaction(() => {
    const refund = getRefundIntent(db, input.orderId)
    if (!refund) throw new AppError(404, 'REFUND_NOT_FOUND', '退款申请不存在')
    if (refund.wechatRefundId && refund.wechatRefundId !== input.wechatRefundId) {
      throw new AppError(409, 'WECHAT_REFUND_MISMATCH', '微信退款单号校验失败')
    }
    if (input.eventId) {
      const seen = db.prepare('SELECT id FROM refund_events WHERE event_id = ?').get(input.eventId)
      if (seen) return getOrderById(db, input.orderId)
      db.prepare(`
        INSERT INTO refund_events (event_id, order_id, event_type, raw_payload, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(input.eventId, input.orderId, input.eventType, input.rawPayload, input.now)
    }

    // 回调与查单可交错到达；只有 SUCCESS 可从任何非成功态升级，旧状态不得覆盖成功。
    const nextStatus = refund.status === 'success'
      ? 'success'
      : refund.status === 'closed' && input.status !== 'success'
        ? 'closed'
        : refund.status === 'abnormal' && input.status === 'processing'
          ? 'abnormal'
        : input.status
    if (nextStatus !== refund.status || !refund.wechatRefundId) {
      if (nextStatus === 'success') {
        const order = getOrderById(db, input.orderId)
        if (order.status !== 'paid' && order.status !== 'refunded') {
          throw new AppError(409, 'ORDER_NOT_REFUNDABLE', '订单支付状态异常，无法确认退款')
        }
      }
      db.prepare(`
        UPDATE refunds
        SET status = ?, wechat_refund_id = COALESCE(wechat_refund_id, ?),
            success_at = CASE WHEN ? = 'success' THEN COALESCE(success_at, ?) ELSE success_at END,
            updated_at = ?
        WHERE order_id = ?
      `).run(nextStatus, input.wechatRefundId, nextStatus, input.successAt ?? input.now, input.now, input.orderId)
      if (nextStatus === 'success') {
        db.prepare(`
          UPDATE orders SET status = 'refunded', updated_at = ?
          WHERE id = ? AND status = 'paid'
        `).run(input.now, input.orderId)
      }
      db.prepare(`
        INSERT INTO audit_logs (actor, action, target_type, target_id, details_json, created_at)
        VALUES (?, 'refund.status', 'order', ?, ?, ?)
      `).run(input.actor, input.orderId, JSON.stringify({ from: refund.status, to: nextStatus, outRefundNo: refund.outRefundNo }), input.now)
    }
    return getOrderById(db, input.orderId)
  })()
}

export function recordPayment(
  db: ParkingDatabase,
  input: {
    eventId: string
    eventType: string
    orderId: string
    transactionId: string
    rawPayload: string
    paidAt: string
    now: string
    allowClosed?: boolean
  },
): { order: OrderRecord; duplicate: boolean } {
  return db.transaction(() => {
    const previous = db
      .prepare('SELECT id FROM payment_events WHERE event_id = ?')
      .get(input.eventId) as { id: number } | undefined
    if (previous) return { order: getOrderById(db, input.orderId), duplicate: true }

    const order = getOrderById(db, input.orderId)
    if (
      (order.status === 'paid' || order.status === 'refunded') &&
      order.transactionId &&
      order.transactionId !== input.transactionId
    ) {
      throw new AppError(409, 'PAYMENT_CONFLICT', '订单已经由另一笔交易支付')
    }
    if (
      order.status !== 'pending' &&
      order.status !== 'paid' &&
      order.status !== 'refunded' &&
      !(input.allowClosed && order.status === 'closed')
    ) {
      throw new AppError(409, 'ORDER_NOT_PAYABLE', '当前订单状态不能支付')
    }

    db.prepare(`
      INSERT INTO payment_events (
        event_id, order_id, event_type, transaction_id, raw_payload, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.eventId,
      input.orderId,
      input.eventType,
      input.transactionId,
      input.rawPayload,
      input.now,
    )

    if (order.status !== 'paid' && order.status !== 'refunded') {
      db.prepare(`
        UPDATE orders
        SET status = 'paid', wechat_transaction_id = ?, paid_at = ?, updated_at = ?
        WHERE id = ? AND status IN ('pending', 'closed')
      `).run(input.transactionId, input.paidAt, input.now, input.orderId)
    }
    return { order: getOrderById(db, input.orderId), duplicate: false }
  })()
}

export function closeOrder(db: ParkingDatabase, orderId: string, now: string): OrderRecord {
  db.prepare(`
    UPDATE orders SET status = 'closed', wechat_prepay_id = NULL, updated_at = ?
    WHERE id = ? AND status = 'pending'
  `).run(now, orderId)
  return getOrderById(db, orderId)
}

function buildOrderWhere(filters: Omit<OrderFilters, 'page' | 'pageSize'>): {
  clause: string
  params: Array<string | number>
} {
  const clauses: string[] = []
  const params: Array<string | number> = []
  if (filters.parkingLotId) {
    clauses.push('o.parking_lot_id = ?')
    params.push(filters.parkingLotId)
  }
  if (filters.from) {
    clauses.push('o.created_at >= ?')
    params.push(filters.from)
  }
  if (filters.to) {
    clauses.push('o.created_at < ?')
    params.push(filters.to)
  }
  if (filters.status) {
    clauses.push('o.status = ?')
    params.push(filters.status)
  }
  if (filters.customerType) {
    clauses.push('o.customer_type = ?')
    params.push(filters.customerType)
  }
  if (filters.durationMonths) {
    clauses.push('o.duration_months = ?')
    params.push(filters.durationMonths)
  }
  if (filters.keyword) {
    clauses.push('(o.plate_number LIKE ? OR o.address LIKE ? OR o.order_no LIKE ?)')
    const keyword = `%${filters.keyword}%`
    params.push(keyword, keyword, keyword)
  }
  return { clause: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params }
}

export function listOrders(db: ParkingDatabase, filters: OrderFilters): OrderList {
  const { clause, params } = buildOrderWhere(filters)
  const count = db.prepare(`SELECT COUNT(*) AS count FROM orders o ${clause}`).get(...params) as {
    count: number
  }
  const offset = (filters.page - 1) * filters.pageSize
  const rows = db
    .prepare(`${ORDER_SELECT} ${clause} ORDER BY o.created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, filters.pageSize, offset) as OrderRow[]
  return {
    items: rows.map(mapOrder),
    total: count.count,
    page: filters.page,
    pageSize: filters.pageSize,
  }
}

export function exportOrders(
  db: ParkingDatabase,
  filters: Omit<OrderFilters, 'page' | 'pageSize'>,
  limit = 20_001,
): OrderRecord[] {
  const { clause, params } = buildOrderWhere(filters)
  const rows = db
    .prepare(`${ORDER_SELECT} ${clause} ORDER BY o.created_at DESC LIMIT ?`)
    .all(...params, limit) as OrderRow[]
  return rows.map(mapOrder)
}

export type SummaryPeriod = 'today' | 'week' | 'month' | 'year'

export function getSummary(db: ParkingDatabase, now: Date, period: SummaryPeriod = 'today', year?: number, parkingLotId?: string): {
  today: { count: number; amount: number }
  month: { count: number; amount: number }
  all: { count: number; amount: number }
  selected: { count: number; amount: number }
  availableYears: number[]
  pendingCount: number
} {
  const current = shanghaiDateParts(now)
  const todayStart = shanghaiDayStartIso(current.year, current.month, current.day)
  const monthStart = shanghaiDayStartIso(current.year, current.month, 1)
  const weekStart = shanghaiDayStartIso(
    current.year, current.month, current.day - ((current.weekday + 6) % 7),
  )
  const selectedYear = year ?? current.year
  const yearStart = shanghaiDayStartIso(selectedYear, 1, 1)
  const tomorrowStart = shanghaiDayStartIso(current.year, current.month, current.day + 1)
  const selectedFrom = { today: todayStart, week: weekStart, month: monthStart, year: yearStart }[period]
  const selectedTo = period === 'year' && selectedYear < current.year
    ? shanghaiDayStartIso(selectedYear + 1, 1, 1)
    : tomorrowStart
  const aggregate = (from?: string, to?: string): { count: number; amount: number } => {
    const row = db
      .prepare(`
        SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS amount
        FROM orders
        WHERE status = 'paid' ${parkingLotId ? 'AND parking_lot_id = ?' : ''}
          ${from ? 'AND paid_at >= ?' : ''} ${to ? 'AND paid_at < ?' : ''}
      `)
      .get(...(parkingLotId ? [parkingLotId] : []), ...(from ? [from] : []), ...(to ? [to] : [])) as { count: number; amount: number }
    return row
  }
  // 已退款订单也保留在可选年份中，但不计入任何实收金额。
  const earliest = db.prepare(`
    SELECT MIN(paid_at) AS paidAt FROM orders
    WHERE paid_at IS NOT NULL ${parkingLotId ? 'AND parking_lot_id = ?' : ''}
  `).get(...(parkingLotId ? [parkingLotId] : [])) as {
    paidAt: string | null
  }
  const firstYear = earliest.paidAt
    ? Math.min(shanghaiDateParts(new Date(earliest.paidAt)).year, current.year)
    : current.year
  const availableYears = Array.from(
    { length: current.year - firstYear + 1 }, (_, index) => current.year - index,
  )
  const pending = db.prepare(`
    SELECT COUNT(*) AS count FROM orders
    WHERE status = 'pending' ${parkingLotId ? 'AND parking_lot_id = ?' : ''}
  `).get(...(parkingLotId ? [parkingLotId] : [])) as {
    count: number
  }
  return {
    today: aggregate(todayStart),
    month: aggregate(monthStart),
    all: aggregate(),
    selected: aggregate(selectedFrom, selectedTo),
    availableYears,
    pendingCount: pending.count,
  }
}
