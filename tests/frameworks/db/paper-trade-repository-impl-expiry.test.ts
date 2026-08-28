/**
 * N4' 修复测试：过期扫描按 trading_calendar 数交易日
 *
 * 章鱼实测：7 自然日近似在国庆/春节误杀（9-30 下单 10-09 撮合，0 交易日即被处决）
 * 修复后：用 trading_calendar 计算交易日数，>=6 才 expired
 *
 * lint-tests:allow-ddl——仓储实现测试需要手写 DDL 建立最小表结构（测试 PaperTradeRepositoryImpl 的 SQL 行为，
 * 不走生产 schema 迁移链，隔离内存 SQLite 无漂移风险）
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { PaperTradeRepositoryImpl } from '@frameworks/db/paper-trade-repository-impl';

/** 初始化 schema（纸面交易相关表） */
function initSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS paper_accounts (
      id TEXT PRIMARY KEY,
      initial_cash REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS paper_cash (
      account_id TEXT PRIMARY KEY,
      cash REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS paper_orders (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      code TEXT NOT NULL,
      side TEXT NOT NULL CHECK(side IN ('buy', 'sell')),
      shares INTEGER NOT NULL,
      reason TEXT NOT NULL CHECK(length(reason) >= 30),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'filled', 'rejected', 'expired')),
      reject_reason TEXT
    );
    CREATE TABLE IF NOT EXISTS paper_trades (
      order_id TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      side TEXT NOT NULL,
      shares INTEGER NOT NULL,
      price REAL NOT NULL,
      fee REAL NOT NULL,
      trade_date TEXT NOT NULL,
      executed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS paper_nav_history (
      account_id TEXT NOT NULL,
      date TEXT NOT NULL,
      cash REAL NOT NULL,
      market_value REAL NOT NULL,
      total REAL NOT NULL,
      nav REAL NOT NULL,
      PRIMARY KEY (account_id, date)
    );
    CREATE TABLE IF NOT EXISTS paper_positions (
      account_id TEXT NOT NULL,
      code TEXT NOT NULL,
      shares INTEGER NOT NULL,
      avg_cost REAL NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (account_id, code)
    );
    CREATE TABLE IF NOT EXISTS paper_reports (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL DEFAULT '',
      date TEXT NOT NULL,
      type TEXT NOT NULL,
      numbers_md TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS trading_calendar (
      date TEXT PRIMARY KEY,
      is_trading_day INTEGER NOT NULL DEFAULT 1,
      year INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS paper_corporate_actions (
      code TEXT NOT NULL,
      date TEXT NOT NULL,
      detected_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (code, date)
    );
  `);
}

/** 生成指定年份的交易日历（简化：周一到周五 = 交易日，无节假日） */
function generateSimpleCalendar(db: Database.Database, year: number, holidays: string[] = []) {
  const holidaySet = new Set(holidays);
  const insert = db.prepare('INSERT OR IGNORE INTO trading_calendar (date, is_trading_day, year) VALUES (?, ?, ?)');

  const start = new Date(year, 0, 1);
  const end = new Date(year, 11, 31);
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const day = d.getDay();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const dateStr = `${y}-${m}-${dd}`;
    const isWeekday = day >= 1 && day <= 5;
    const isHoliday = holidaySet.has(dateStr);
    insert.run(dateStr, isWeekday && !isHoliday ? 1 : 0, year);
  }
}

/** 创建 pending 订单（指定 created_at） */
function insertOrder(
  db: Database.Database,
  orderId: string,
  accountId: string,
  createdAt: string,
) {
  db.prepare(`
    INSERT INTO paper_orders (id, account_id, code, side, shares, reason, created_at, status, reject_reason)
    VALUES (?, ?, '600519', 'buy', 100, 'test reason long enough for validation thirty chars', ?, 'pending', NULL)
  `).run(orderId, accountId, createdAt);
}

describe('expireOldPendingOrders (N4 交易日过期扫描)', () => {
  let db: Database.Database;
  let repo: PaperTradeRepositoryImpl;

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    repo = new PaperTradeRepositoryImpl(db);

    // 创建测试账户
    db.prepare(`INSERT INTO paper_accounts (id, initial_cash, status) VALUES ('acc1', 1000000, 'active')`).run();
    db.prepare(`INSERT INTO paper_cash (account_id, cash) VALUES ('acc1', 1000000)`).run();
  });

  it('国庆场景：9-30 下单 10-09 撮合，0 交易日不处决', async () => {
    // 生成 2026 年交易日历（含国庆假期 10-01 ~ 10-07）
    generateSimpleCalendar(db, 2026, [
      '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
      '2026-10-05', '2026-10-06', '2026-10-07',
    ]);

    // 9-30 周三下单
    insertOrder(db, 'order-national-day', 'acc1', '2026-09-30T15:30:00.000Z');

    // 10-09 周四撮合（假期后第一个交易日）
    const expired = await repo.expireOldPendingOrders('acc1', '2026-10-09');

    // 0 次撮合机会 → 不应过期
    expect(expired).toBe(0);
    const order = await repo.getOrder('order-national-day');
    expect(order?.status).toBe('pending');
  });

  it('春节场景：2-13 下单 2-24 撮合，0 交易日不处决', async () => {
    generateSimpleCalendar(db, 2026, [
      // 春节假期（含周末）：2-14 ~ 2-20（实际 2-14 周六, 2-15 周日, 2-16~2-20 调休）
      '2026-02-14', '2026-02-15', '2026-02-16', '2026-02-17',
      '2026-02-18', '2026-02-19', '2026-02-20',
    ]);

    // 2-13 周五下单
    insertOrder(db, 'order-spring-festival', 'acc1', '2026-02-13T15:30:00.000Z');

    // 2-24 周二撮合（假期后第一个交易日）
    const expired = await repo.expireOldPendingOrders('acc1', '2026-02-24');

    // 0 次撮合机会 → 不应过期
    expect(expired).toBe(0);
    const order = await repo.getOrder('order-spring-festival');
    expect(order?.status).toBe('pending');
  });

  it('正常场景：8-25 下单 8-26 撮合，1 交易日不处决', async () => {
    generateSimpleCalendar(db, 2026);
    insertOrder(db, 'order-normal', 'acc1', '2026-08-25T15:30:00.000Z');

    const expired = await repo.expireOldPendingOrders('acc1', '2026-08-26');
    expect(expired).toBe(0);
  });

  it('第 5 次撮合机会当日仍可撮合（count=5 不过期）', async () => {
    generateSimpleCalendar(db, 2026);
    // 8-19 周二下单，8-20~8-26（跳过周末）= 5 个交易日
    insertOrder(db, 'order-5th-opportunity', 'acc1', '2026-08-19T15:30:00.000Z');

    // 8-26 周二（第 5 次撮合机会）
    const expired = await repo.expireOldPendingOrders('acc1', '2026-08-26');

    // 8-20,8-21,8-22,8-25,8-26 = 5 个交易日（created_at > 8-19 的区间），count=5 < 6，不过期
    // T1 修复：原注释误写 count=6，实际应为 5
    expect(expired).toBe(0);
    const order = await repo.getOrder('order-5th-opportunity');
    expect(order?.status).toBe('pending');
  });

  it('恰好第 6 个交易日才 expired（count=6）', async () => {
    generateSimpleCalendar(db, 2026);
    // 8-19 周二下单，8-20~8-27（跳过周末）= 6 个交易日
    insertOrder(db, 'order-6th-expired', 'acc1', '2026-08-19T15:30:00.000Z');

    // 8-27 周三（第 6 次撮合机会）
    const expired = await repo.expireOldPendingOrders('acc1', '2026-08-27');

    // 8-20,8-21,8-22,8-25,8-26,8-27 = 6 个交易日，count=6 >= 6，expired
    expect(expired).toBe(1);
    const order = await repo.getOrder('order-6th-expired');
    expect(order?.status).toBe('expired');
    expect(order?.rejectReason).toBe('expired_5_trading_days');
  });

  it('跨周末场景：周五下单下周一撮合', async () => {
    generateSimpleCalendar(db, 2026);
    // 8-21 周五下单
    insertOrder(db, 'order-weekend', 'acc1', '2026-08-21T15:30:00.000Z');

    // 8-24 周一撮合（只过了 1 个交易日 8-24）
    const expired = await repo.expireOldPendingOrders('acc1', '2026-08-24');
    expect(expired).toBe(0);
  });
});
