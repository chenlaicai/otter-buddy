/**
 * X1 P0 集成测试：成交订单 DB 状态落库验证
 *
 * 章鱼第三轮复核发现：executeMatch 重构时丢失了 updateOrderStatus(order.id, 'filled', null)，
 * 导致成交订单在 DB 里永远是 pending。全 mock 测试结构上不可能发现此缺陷。
 *
 * 本测试使用真实 Ledger + 真实 SQLite（PaperTradeRepositoryImpl）+ 仅 mock 行情网关，
 * 断言成交后 DB 状态 = 'filled'，且 Day2 重跑 matchOrders 不再捞起已成交订单。
 *
 * lint-tests:allow-ddl——仓储实现测试需要手写 DDL 建立最小表结构
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { Ledger } from '@usecases/paper-trading/ledger';
import { PaperTradeRepositoryImpl } from '@frameworks/db/paper-trade-repository-impl';
import type { StockQuoteGateway } from '@usecases/paper-trading/stock-quote-gateway';

/** 初始化 schema */
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

/** 生成交易日历 */
function generateCalendar(db: Database.Database, year: number, holidays: string[] = []) {
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
    insert.run(dateStr, isWeekday && !holidaySet.has(dateStr) ? 1 : 0, year);
  }
}

/** 创建 pending 订单 */
function insertPendingOrder(
  db: Database.Database,
  orderId: string,
  accountId: string,
  code: string,
  side: 'buy' | 'sell',
  shares: number,
  createdAt: string,
) {
  db.prepare(`
    INSERT INTO paper_orders (id, account_id, code, side, shares, reason, created_at, status, reject_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL)
  `).run(orderId, accountId, code, side, shares, 'test reason long enough for validation thirty chars', createdAt);
}

describe('X1 P0: 交成订单 DB 状态落库集成测试', () => {
  let db: Database.Database;
  let repo: PaperTradeRepositoryImpl;

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    generateCalendar(db, 2026);
    repo = new PaperTradeRepositoryImpl(db);

    // 创建账户
    db.prepare(`INSERT INTO paper_accounts (id, initial_cash, status) VALUES ('acc1', 1000000, 'active')`).run();
    db.prepare(`INSERT INTO paper_cash (account_id, cash) VALUES ('acc1', 1000000)`).run();
  });

  it('① 买单成交后 DB status = filled', async () => {
    // 8-26 创建买单
    insertPendingOrder(db, 'buy-order-1', 'acc1', '600519', 'buy', 100, '2026-08-26T15:30:00.000Z');

    // Mock 行情：600519 开盘 1800
    const gateway: StockQuoteGateway = {
      getQuotes: async () => ({
        '600519': { code: '600519', date: '2026-08-27', open: 1800, close: 1800, prevClose: 1790, high: 1800, low: 1800 },
      }),
      getClosePrice: async () => 1800,
      getPrevClose: async () => 1790,
      getTodayOpen: async () => 1800,
    };
    const l = new Ledger(repo, gateway);

    // 8-27 撮合
    const results = await l.matchOrders('acc1', '2026-08-27');

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('filled');

    // 核心断言：DB 里 status = filled
    const order = await repo.getOrder('buy-order-1');
    expect(order?.status).toBe('filled');
    expect(order?.rejectReason).toBeNull();

    // 成交记录存在
    const trades = await repo.getTradesByDate('acc1', '2026-08-27');
    expect(trades).toHaveLength(1);
    expect(trades[0].orderId).toBe('buy-order-1');
  });

  it('② Day2 重跑 matchOrders 不再捞起已成交订单', async () => {
    insertPendingOrder(db, 'buy-order-1', 'acc1', '600519', 'buy', 100, '2026-08-26T15:30:00.000Z');

    const gateway: StockQuoteGateway = {
      getQuotes: async () => ({
        '600519': { code: '600519', date: '2026-08-27', open: 1800, close: 1800, prevClose: 1790, high: 1800, low: 1800 },
      }),
      getClosePrice: async () => 1800,
      getPrevClose: async () => 1790,
      getTodayOpen: async () => 1800,
    };
    const l = new Ledger(repo, gateway);

    // Day1 撮合
    await l.matchOrders('acc1', '2026-08-27');

    // Day2 重跑——不应捞起已成交订单
    const gateway2: StockQuoteGateway = {
      getQuotes: async () => ({
        '600519': { code: '600519', date: '2026-08-28', open: 1850, close: 1850, prevClose: 1800, high: 1850, low: 1850 },
      }),
      getClosePrice: async () => 1850,
      getPrevClose: async () => 1800,
      getTodayOpen: async () => 1850,
    };
    const l2 = new Ledger(repo, gateway2);

    // Day2 撮合——pending 列表应为空，不撞 paper_trades.order_id UNIQUE
    const results = await l2.matchOrders('acc1', '2026-08-28');
    expect(results).toHaveLength(0);
  });

  it('③ 卖单链：成交后现金到账 + 持仓删除 + 状态正确', async () => {
    // 先建持仓
    db.prepare(`INSERT INTO paper_positions (account_id, code, shares, avg_cost) VALUES ('acc1', '600519', 100, 1800)`).run();

    // 8-26 创建卖单
    insertPendingOrder(db, 'sell-order-1', 'acc1', '600519', 'sell', 100, '2026-08-26T15:30:00.000Z');

    const gateway: StockQuoteGateway = {
      getQuotes: async () => ({
        '600519': { code: '600519', date: '2026-08-27', open: 1850, close: 1850, prevClose: 1800, high: 1850, low: 1850 },
      }),
      getClosePrice: async () => 1850,
      getPrevClose: async () => 1800,
      getTodayOpen: async () => 1850,
    };
    const l = new Ledger(repo, gateway);

    const results = await l.matchOrders('acc1', '2026-08-27');

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('filled');

    // 核心断言：DB 里 status = filled
    const order = await repo.getOrder('sell-order-1');
    expect(order?.status).toBe('filled');

    // 现金到账：1000000 + 1850*100 - fee
    const cash = await repo.getCash('acc1');
    expect(cash).toBeGreaterThan(1000000);

    // 持仓已删除
    const position = await repo.getPosition('acc1', '600519');
    expect(position).toBeNull();
  });

  it('④ 多笔买单序列：现金逐笔扣减，不会出现负现金', async () => {
    insertPendingOrder(db, 'buy-1', 'acc1', '600519', 'buy', 100, '2026-08-26T15:30:00.000Z');
    insertPendingOrder(db, 'buy-2', 'acc1', '000001', 'buy', 100, '2026-08-26T15:30:00.000Z');

    // 现金只有 20 万，第一笔买 100 股 @ 1800 = 18 万 + fee，第二笔 100 股 @ 1500 = 15 万 + fee
    db.prepare(`UPDATE paper_cash SET cash = 200000 WHERE account_id = 'acc1'`).run();

    const gateway: StockQuoteGateway = {
      getQuotes: async () => ({
        '600519': { code: '600519', date: '2026-08-27', open: 1800, close: 1800, prevClose: 1790, high: 1800, low: 1800 },
        '000001': { code: '000001', date: '2026-08-27', open: 1500, close: 1500, prevClose: 1490, high: 1500, low: 1500 },
      }),
      getClosePrice: async () => 1800,
      getPrevClose: async () => 1790,
      getTodayOpen: async () => 1800,
    };
    const l = new Ledger(repo, gateway);

    const results = await l.matchOrders('acc1', '2026-08-27');

    expect(results).toHaveLength(2);
    // 第一笔成交
    expect(results[0].status).toBe('filled');
    // 第二笔因现金不足被拒
    expect(results[1].status).toBe('rejected');
    expect(results[1].rejectReason).toBe('insufficient_cash_at_match');

    // 现金断言：不应出现负数
    const cash = await repo.getCash('acc1');
    expect(cash).toBeGreaterThanOrEqual(0);

    // 成交订单 DB 状态
    expect((await repo.getOrder('buy-1'))?.status).toBe('filled');
    expect((await repo.getOrder('buy-2'))?.status).toBe('rejected');
  });

  it('⑤ 负现金不可能出现断言（串行撮合 + 终验）', async () => {
    // 极端场景：现金 1 元，买 10000 股
    db.prepare(`UPDATE paper_cash SET cash = 1 WHERE account_id = 'acc1'`).run();
    insertPendingOrder(db, 'buy-extreme', 'acc1', '600519', 'buy', 100, '2026-08-26T15:30:00.000Z');

    const gateway: StockQuoteGateway = {
      getQuotes: async () => ({
        '600519': { code: '600519', date: '2026-08-27', open: 1800, close: 1800, prevClose: 1790, high: 1800, low: 1800 },
      }),
      getClosePrice: async () => 1800,
      getPrevClose: async () => 1790,
      getTodayOpen: async () => 1800,
    };
    const l = new Ledger(repo, gateway);

    const results = await l.matchOrders('acc1', '2026-08-27');
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('rejected');

    // 负现金断言
    const cash = await repo.getCash('acc1');
    expect(cash).toBeGreaterThanOrEqual(0);
    expect(cash).toBe(1); // 未变动
  });
});
