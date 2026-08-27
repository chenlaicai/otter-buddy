/* eslint-disable max-lines-per-function -- PR4: ledger test covers multiple scenarios (T+1, limit-up, S4 risk control) */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Ledger } from '@usecases/paper-trading/ledger';
import type { PaperTradeRepository } from '@usecases/paper-trading/paper-trade-repository';
import type { StockQuoteGateway, DailyQuote } from '@usecases/paper-trading/stock-quote-gateway';

// Mock repository
const mockRepo: PaperTradeRepository = {
  createAccount: vi.fn(),
  getAccount: vi.fn(),
  createPosition: vi.fn(),
  updatePosition: vi.fn(),
  deletePosition: vi.fn(),
  getPosition: vi.fn(),
  getPositions: vi.fn(),
  getCash: vi.fn(),
  updateCash: vi.fn(),
  createOrder: vi.fn(),
  getOrder: vi.fn(),
  getOrders: vi.fn(),
  getPendingOrders: vi.fn(),
  updateOrderStatus: vi.fn(),
  findExistingOrder: vi.fn(),
  getTodayOrderCount: vi.fn(),
  getLastBuyTradeDate: vi.fn(),
  expireOldPendingOrders: vi.fn(),
  createTrade: vi.fn(),
  getTrades: vi.fn(),
  getTradesByDate: vi.fn(),
  createNavHistory: vi.fn(),
  getNavHistory: vi.fn(),
  getLatestNav: vi.fn(),
  createReport: vi.fn(),
  getReport: vi.fn(),
  isTradingDay: vi.fn(),
  getTradingDays: vi.fn(),
  syncTradingCalendar: vi.fn(),
  markCorporateAction: vi.fn(),
};

// Mock gateway — 默认返回合理行情
const mockGateway: StockQuoteGateway = {
  getQuotes: vi.fn(),
  getClosePrice: vi.fn(),
  getPrevClose: vi.fn(),
  getTodayOpen: vi.fn(),
};

/** 默认行情 mock 工厂 */
function mockQuote(code: string, open: number, prevClose: number): DailyQuote {
  return {
    code,
    date: '2026-08-27',
    open,
    close: open, // 简化：收盘=开盘
    prevClose,
    high: open * 1.05,
    low: open * 0.95,
  };
}

describe('Ledger', () => {
  let ledger: Ledger;

  beforeEach(() => {
    vi.clearAllMocks();
    ledger = new Ledger(mockRepo, mockGateway);
  });

  describe('createAccount', () => {
    it('should create account with initial cash', async () => {
      const account = await ledger.createAccount(1000000);
      
      expect(account).toHaveProperty('id');
      expect(account).toHaveProperty('initialCash', 1000000);
      expect(account).toHaveProperty('status', 'active');
      expect(mockRepo.createAccount).toHaveBeenCalled();
    });
  });

  describe('submitOrder', () => {
    it('should submit buy order with valid parameters', async () => {
      const mockAccount = {
        id: 'test-account',
        initialCash: 1000000,
        status: 'active',
        createdAt: new Date().toISOString(),
      };
      
      (mockRepo.getAccount as any).mockResolvedValue(mockAccount);
      (mockRepo.findExistingOrder as any).mockResolvedValue(null);
      (mockRepo.getTodayOrderCount as any).mockResolvedValue(0);
      (mockRepo.getCash as any).mockResolvedValue(1000000);
      (mockRepo.getPositions as any).mockResolvedValue([]);
      (mockRepo.getLatestNav as any).mockResolvedValue(null);
      // S4: 现金预检用真实价格
      (mockGateway.getClosePrice as any).mockResolvedValue(50);

      const order = await ledger.submitOrder(
        'test-account',
        '600519',
        'buy',
        100,
        '贵州茅台业绩持续增长，技术面突破关键阻力位，计划分批建仓观察走势发展'
      );

      expect(order).toHaveProperty('id');
      expect(order).toHaveProperty('accountId', 'test-account');
      expect(order).toHaveProperty('code', '600519');
      expect(order).toHaveProperty('side', 'buy');
      expect(order).toHaveProperty('shares', 100);
      expect(order).toHaveProperty('status', 'pending');
      expect(mockRepo.createOrder).toHaveBeenCalled();
    });

    it('should reject invalid stock code', async () => {
      await expect(
        ledger.submitOrder('test-account', 'invalid', 'buy', 100, '理由')
      ).rejects.toThrow('Invalid stock code');
    });

    it('should reject reason less than 30 characters', async () => {
      await expect(
        ledger.submitOrder('test-account', '600519', 'buy', 100, '短')
      ).rejects.toThrow('Reason too short');
    });

    it('should reject buy shares not multiple of 100', async () => {
      await expect(
        ledger.submitOrder('test-account', '600519', 'buy', 150, '贵州茅台业绩增长，技术面突破，计划建仓观察')
      ).rejects.toThrow('Buy shares must be multiple of 100');
    });

    it('should check cash with real price (S4 fix)', async () => {
      const mockAccount = {
        id: 'test-account',
        initialCash: 1000000,
        status: 'active',
        createdAt: new Date().toISOString(),
      };
      (mockRepo.getAccount as any).mockResolvedValue(mockAccount);
      (mockRepo.findExistingOrder as any).mockResolvedValue(null);
      (mockRepo.getTodayOrderCount as any).mockResolvedValue(0);
      // 只有 5000 元现金
      (mockRepo.getCash as any).mockResolvedValue(5000);
      (mockRepo.getPositions as any).mockResolvedValue([]);
      (mockRepo.getLatestNav as any).mockResolvedValue(null);
      // 股价 100 元，买 100 股需要 10000+元
      (mockGateway.getClosePrice as any).mockResolvedValue(100);

      await expect(
        ledger.submitOrder('test-account', '600519', 'buy', 100,
          '贵州茅台业绩持续增长，技术面突破关键阻力位，计划分批建仓观察发展')
      ).rejects.toThrow('Insufficient cash');
    });
  });

  describe('matchOrders', () => {
    it('should return empty array for non-trading day', async () => {
      (mockRepo.isTradingDay as any).mockResolvedValue(false);

      const results = await ledger.matchOrders('test-account', '2026-08-27');
      expect(results).toEqual([]);
    });

    it('should return empty array when no pending orders', async () => {
      (mockRepo.isTradingDay as any).mockResolvedValue(true);
      (mockRepo.expireOldPendingOrders as any).mockResolvedValue(0);
      (mockRepo.getPendingOrders as any).mockResolvedValue([]);

      const results = await ledger.matchOrders('test-account', '2026-08-27');
      expect(results).toEqual([]);
    });

    it('should only match orders created before tradeDate (S2 T+1 guard)', async () => {
      (mockRepo.isTradingDay as any).mockResolvedValue(true);
      (mockRepo.expireOldPendingOrders as any).mockResolvedValue(0);

      const pendingOrders = [
        // 当天创建的订单——不应被撮合
        {
          id: 'order-today', accountId: 'test-account', code: '600519',
          side: 'buy' as const, shares: 100, reason: 'test reason long enough for validation thirty chars',
          createdAt: '2026-08-27T15:30:00.000Z', status: 'pending' as const, rejectReason: null,
        },
        // 前一天创建的订单——应被撮合
        {
          id: 'order-yesterday', accountId: 'test-account', code: '000001',
          side: 'buy' as const, shares: 100, reason: 'test reason long enough for validation thirty chars',
          createdAt: '2026-08-26T15:30:00.000Z', status: 'pending' as const, rejectReason: null,
        },
      ];

      (mockRepo.getPendingOrders as any).mockResolvedValue(pendingOrders);
      (mockGateway.getQuotes as any).mockResolvedValue({
        '600519': mockQuote('600519', 1800, 1790),
        '000001': mockQuote('000001', 15, 14.5),
      });
      (mockRepo.getCash as any).mockResolvedValue(1000000);
      (mockRepo.getLatestNav as any).mockResolvedValue(null);
      (mockRepo.getPosition as any).mockResolvedValue(null);
      (mockRepo.getNavHistory as any).mockResolvedValue(null);
      (mockRepo.getPositions as any).mockResolvedValue([]);
      (mockRepo.getTradesByDate as any).mockResolvedValue([]);
      (mockRepo.getAccount as any).mockResolvedValue({ id: 'test-account', initialCash: 1000000 });

      const results = await ledger.matchOrders('test-account', '2026-08-27');

      // 只有 order-yesterday 应被撮合（order-today createdDate == tradeDate，跳过）
      expect(results).toHaveLength(1);
      expect(results[0].orderId).toBe('order-yesterday');
      expect(results[0].status).toBe('filled');
    });

    it('should keep limit_up orders pending (S3 fix)', async () => {
      (mockRepo.isTradingDay as any).mockResolvedValue(true);
      (mockRepo.expireOldPendingOrders as any).mockResolvedValue(0);

      const pendingOrder = {
        id: 'order-buy', accountId: 'test-account', code: '600519',
        side: 'buy' as const, shares: 100, reason: 'test reason long enough for validation thirty chars',
        createdAt: '2026-08-26T15:30:00.000Z', status: 'pending' as const, rejectReason: null,
      };

      (mockRepo.getPendingOrders as any).mockResolvedValue([pendingOrder]);
      // 开盘价 = 涨停价（prevClose * 1.1 = 100 * 1.1 = 110）
      (mockGateway.getQuotes as any).mockResolvedValue({
        '600519': mockQuote('600519', 110, 100),
      });
      (mockRepo.getPositions as any).mockResolvedValue([]);
      (mockRepo.getTradesByDate as any).mockResolvedValue([]);
      (mockRepo.getAccount as any).mockResolvedValue({ id: 'test-account', initialCash: 1000000 });
      (mockRepo.getCash as any).mockResolvedValue(1000000);
      (mockRepo.getNavHistory as any).mockResolvedValue(null);

      const results = await ledger.matchOrders('test-account', '2026-08-27');

      expect(results).toHaveLength(1);
      // S3: 涨停不成交保持 pending（不是 rejected）
      expect(results[0].status).toBe('limit_up');
      expect(results[0].trade).toBeNull();
    });

    it('should check T+1 at match time (S4 fix)', async () => {
      (mockRepo.isTradingDay as any).mockResolvedValue(true);
      (mockRepo.expireOldPendingOrders as any).mockResolvedValue(0);

      const sellOrder = {
        id: 'order-sell', accountId: 'test-account', code: '600519',
        side: 'sell' as const, shares: 100, reason: 'test reason long enough for validation thirty chars',
        createdAt: '2026-08-26T15:30:00.000Z', status: 'pending' as const, rejectReason: null,
      };

      (mockRepo.getPendingOrders as any).mockResolvedValue([sellOrder]);
      (mockGateway.getQuotes as any).mockResolvedValue({
        '600519': mockQuote('600519', 1800, 1790),
      });
      // 当天有买入成交 → T+1 限制
      (mockRepo.getLastBuyTradeDate as any).mockResolvedValue('2026-08-27');

      const results = await ledger.matchOrders('test-account', '2026-08-27');

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('pending');
      expect(results[0].rejectReason).toBe('t_plus_1_restriction');
    });

    it('should reject buy order at match time if cash insufficient due to gap (N2 fix)', async () => {
      (mockRepo.isTradingDay as any).mockResolvedValue(true);
      (mockRepo.expireOldPendingOrders as any).mockResolvedValue(0);

      // 两笔买单，预检时收盘价 60 元各 1000 股 → 各需 6 万元，总 12 万，现金 10 万
      // 但两笔都预检通过（分别检查时各 6 万 < 10 万）
      const buyOrder1 = {
        id: 'order-1', accountId: 'test-account', code: '600519',
        side: 'buy' as const, shares: 1000, reason: 'test reason long enough for validation thirty chars',
        createdAt: '2026-08-26T15:30:00.000Z', status: 'pending' as const, rejectReason: null,
      };
      const buyOrder2 = {
        id: 'order-2', accountId: 'test-account', code: '000001',
        side: 'buy' as const, shares: 1000, reason: 'test reason long enough for validation thirty chars',
        createdAt: '2026-08-26T15:30:00.000Z', status: 'pending' as const, rejectReason: null,
      };

      (mockRepo.getPendingOrders as any).mockResolvedValue([buyOrder1, buyOrder2]);
      // T+1 开盘跳空 65 元（+8.3%），两笔都按 65 元成交
      (mockGateway.getQuotes as any).mockResolvedValue({
        '600519': mockQuote('600519', 65, 60),
        '000001': mockQuote('000001', 65, 60),
      });

      // getCash 序列：order-1 validation(100000) → order-1 updateCash(100000) → order-2 validation(34984)
      (mockRepo.getCash as any)
        .mockResolvedValueOnce(100000)  // order-1 validation → passes
        .mockResolvedValueOnce(100000)  // order-1 updateCash → reads current cash
        .mockResolvedValueOnce(34984);  // order-2 validation → 34984 < 65016.25 → REJECTED
      (mockRepo.getPosition as any).mockResolvedValue(null);
      (mockRepo.getPositions as any).mockResolvedValue([]);
      (mockRepo.getNavHistory as any).mockResolvedValue(null);
      (mockRepo.getLatestNav as any).mockResolvedValue(null);
      (mockRepo.getTradesByDate as any).mockResolvedValue([]);
      (mockRepo.getAccount as any).mockResolvedValue({ id: 'test-account', initialCash: 1000000 });

      const results = await ledger.matchOrders('test-account', '2026-08-27');

      expect(results).toHaveLength(2);
      // 第一笔成交
      expect(results[0].status).toBe('filled');
      // 第二笔因现金不足被拒（N2: insufficient_cash_at_match）
      expect(results[1].status).toBe('pending');
      expect(results[1].rejectReason).toBe('insufficient_cash_at_match');

      // 负现金断言：updateCash 不应写入负数
      const updateCashCalls = (mockRepo.updateCash as any).mock.calls;
      for (const call of updateCashCalls) {
        expect(call[1]).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('submitOrder (N2 null→0 bypass fix)', () => {
    it('should reject buy order when market data unavailable (null→0 fix)', async () => {
      const mockAccount = {
        id: 'test-account',
        initialCash: 1000000,
        status: 'active',
        createdAt: new Date().toISOString(),
      };
      (mockRepo.getAccount as any).mockResolvedValue(mockAccount);
      (mockRepo.findExistingOrder as any).mockResolvedValue(null);
      (mockRepo.getTodayOrderCount as any).mockResolvedValue(0);
      (mockRepo.getCash as any).mockResolvedValue(100000);
      (mockRepo.getPositions as any).mockResolvedValue([]);
      (mockRepo.getLatestNav as any).mockResolvedValue(null);
      // 行情不可得 → null（停牌/无数据）
      (mockGateway.getClosePrice as any).mockResolvedValue(null);

      await expect(
        ledger.submitOrder('test-account', '600519', 'buy', 100,
          '贵州茅台业绩持续增长，技术面突破关键阻力位，计划分批建仓观察发展')
      ).rejects.toThrow('Market data unavailable');
    });
  });

  describe('getPerformance', () => {
    it('should calculate return rate correctly', async () => {
      const mockAccount = {
        id: 'test-account',
        initialCash: 1000000,
        status: 'active',
        createdAt: new Date().toISOString(),
      };

      const mockNavHistory = [
        {
          accountId: 'test-account',
          date: '2026-08-25',
          cash: 500000,
          marketValue: 600000,
          total: 1100000,
          nav: 1.1,
        },
        {
          accountId: 'test-account',
          date: '2026-08-26',
          cash: 500000,
          marketValue: 650000,
          total: 1150000,
          nav: 1.15,
        },
      ];

      (mockRepo.getAccount as any).mockResolvedValue(mockAccount);
      (mockRepo.getNavHistory as any).mockResolvedValue(mockNavHistory);

      const performance = await ledger.getPerformance('test-account');
      expect(performance.returnRate).toBe(15);
    });
  });

  describe('calculateNav', () => {
    it('should use gateway for close prices (S1 fix)', async () => {
      const mockAccount = {
        id: 'test-account',
        initialCash: 1000000,
        status: 'active',
        createdAt: new Date().toISOString(),
      };
      const mockPositions = [
        { accountId: 'test-account', code: '600519', shares: 100, avgCost: 1800, updatedAt: '' },
        { accountId: 'test-account', code: '000001', shares: 200, avgCost: 15, updatedAt: '' },
      ];

      (mockRepo.getAccount as any).mockResolvedValue(mockAccount);
      (mockRepo.getCash as any).mockResolvedValue(500000);
      (mockRepo.getPositions as any).mockResolvedValue(mockPositions);
      // S1: 真实行情而非硬编码 10 元
      (mockGateway.getClosePrice as any)
        .mockResolvedValueOnce(1850) // 600519 收盘 1850
        .mockResolvedValueOnce(16);  // 000001 收盘 16

      const nav = await ledger.calculateNav('test-account', '2026-08-27');

      // 持仓市值 = 100 * 1850 + 200 * 16 = 185000 + 3200 = 188200
      expect(nav.marketValue).toBe(188200);
      // 总资产 = 500000 + 188200 = 688200
      expect(nav.total).toBe(688200);
      // 净值 = 688200 / 1000000 = 0.6882
      expect(nav.nav).toBeCloseTo(0.6882);
    });
  });
});
