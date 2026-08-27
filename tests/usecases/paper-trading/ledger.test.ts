import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Ledger } from '@usecases/paper-trading/ledger';
import type { PaperTradeRepository } from '@usecases/paper-trading/paper-trade-repository';

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
  getLastBuyDate: vi.fn(),
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
  markCorporateAction: vi.fn(),
};

describe('Ledger', () => {
  let ledger: Ledger;

  beforeEach(() => {
    vi.clearAllMocks();
    ledger = new Ledger(mockRepo);
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
  });

  describe('matchOrders', () => {
    it('should return empty array for non-trading day', async () => {
      (mockRepo.isTradingDay as any).mockResolvedValue(false);

      const results = await ledger.matchOrders('test-account', '2026-08-27');
      expect(results).toEqual([]);
    });

    it('should return empty array when no pending orders', async () => {
      (mockRepo.isTradingDay as any).mockResolvedValue(true);
      (mockRepo.getPendingOrders as any).mockResolvedValue([]);

      const results = await ledger.matchOrders('test-account', '2026-08-27');
      expect(results).toEqual([]);
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
});
