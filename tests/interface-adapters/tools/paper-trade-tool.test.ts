import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPaperTradeTool } from '@interface-adapters/agent-runtime/tools/paper-trade-tool';
import type { ToolContext } from '@usecases/ports/agent-tools';
import type { Ledger } from '@usecases/paper-trading/ledger';

describe('Paper Trade Tool', () => {
  let paperTradeTool: any;
  let mockCtx: ToolContext;
  let mockLedger: Ledger;
  let mockGetAccountId: () => string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCtx = {
      client: {} as any,
      otterId: 'test-otter',
      conversationId: 'test-conv',
      currentMessageId: 'test-msg',
    };
    mockLedger = {
      submitOrder: vi.fn(),
      getAccount: vi.fn(),
      getOrders: vi.fn(),
      getTrades: vi.fn(),
      getNavHistory: vi.fn(),
      getPerformance: vi.fn(),
      getReport: vi.fn(),
      isTradingDay: vi.fn(),
      getAccountSnapshot: vi.fn(),
    } as any;
    mockGetAccountId = vi.fn().mockReturnValue('test-account');
    paperTradeTool = createPaperTradeTool(mockCtx, mockLedger, mockGetAccountId);
  });

  it('should have correct name', () => {
    expect(paperTradeTool.name).toBe('paper_trade');
  });

  it('should have correct description', () => {
    expect(paperTradeTool.description).toContain('纸面交易工具');
    expect(paperTradeTool.description).toContain('submit_order');
    expect(paperTradeTool.description).toContain('account');
    expect(paperTradeTool.description).toContain('orders');
    expect(paperTradeTool.description).toContain('trades');
    expect(paperTradeTool.description).toContain('nav');
    expect(paperTradeTool.description).toContain('perf');
    expect(paperTradeTool.description).toContain('report');
    expect(paperTradeTool.description).toContain('is_trading_day');
  });

  it('should return error when no account found', async () => {
    mockGetAccountId = vi.fn().mockReturnValue(undefined);
    paperTradeTool = createPaperTradeTool(mockCtx, mockLedger, mockGetAccountId);

    const result = await paperTradeTool.execute('test-call-id', {
      command: 'account',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No paper trading account found');
  });

  it('should handle unknown command', async () => {
    const result = await paperTradeTool.execute('test-call-id', {
      command: 'unknown_command',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown command');
  });

  it('should call getAccountSnapshot for account command', async () => {
    const mockSnapshot = {
      cash: 1000000,
      positions: [],
      total: 1000000,
      nav: 1.0,
    };
    (mockLedger.getAccountSnapshot as any).mockResolvedValue(mockSnapshot);

    const result = await paperTradeTool.execute('test-call-id', {
      command: 'account',
    });

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text)).toEqual(mockSnapshot);
  });

  it('should call isTradingDay for is_trading_day command', async () => {
    (mockLedger.isTradingDay as any).mockResolvedValue(true);

    const result = await paperTradeTool.execute('test-call-id', {
      command: 'is_trading_day',
      date: '2026-08-27',
    });

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text)).toEqual({
      date: '2026-08-27',
      isTradingDay: true,
    });
  });
});
