/**
 * 注册纸面交易函数到函数注册表
 * 
 * PR4: 撮合任务使用 function executor，不创建 agent 会话
 */

import { paperTradingFunctionRegistry } from './function-registry';
import type { Ledger } from './ledger';

/** 注册纸面交易函数 */
export function registerPaperTradingFunctions(ledger: Ledger): void {
  // 注册撮合函数
  paperTradingFunctionRegistry.register('match_orders', async (params) => {
    const { accountId, tradeDate } = params as { accountId: string; tradeDate: string };
    
    const results = await ledger.matchOrders(accountId, tradeDate);
    
    return {
      success: true,
      accountId,
      tradeDate,
      matchedOrders: results.length,
      results,
    };
  });

  // 注册净值计算函数
  paperTradingFunctionRegistry.register('calculate_nav', async (params) => {
    const { accountId, date } = params as { accountId: string; date: string };
    
    const navHistory = await ledger.calculateNav(accountId, date);
    
    return {
      success: true,
      accountId,
      date,
      nav: navHistory.nav,
      total: navHistory.total,
      cash: navHistory.cash,
      marketValue: navHistory.marketValue,
    };
  });

  // 注册日报渲染函数
  paperTradingFunctionRegistry.register('render_daily_report', async (params) => {
    const { accountId, date } = params as { accountId: string; date: string };
    
    // 渲染日报绩效数字段
    const performance = await ledger.getPerformance(accountId);
    const navHistory = await ledger.getNavHistory(accountId);
    
    return {
      success: true,
      accountId,
      date,
      performance,
      navHistory,
    };
  });
}
