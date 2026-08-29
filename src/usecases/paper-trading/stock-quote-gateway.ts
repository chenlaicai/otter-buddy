/**
 * 行情数据网关接口
 * 
 * usecases 层定义接口，frameworks 层实现（调 stock-cli.py kline adjust=""）
 * 全链路不复权口径——与方案 S3 对齐
 */

/** 单日行情快照 */
export interface DailyQuote {
  code: string;
  date: string;
  open: number;
  close: number;
  prevClose: number;
  high: number;
  low: number;
}

/** 行情网关 */
export interface StockQuoteGateway {
  /**
   * 批量获取指定日期行情
   * 返回 code -> DailyQuote 映射；停牌/无数据的不返回
   */
  getQuotes(codes: string[], date: string): Promise<Record<string, DailyQuote>>;

  /**
   * 获取单只股票指定日期收盘价
   * 停牌返回 null
   */
  getClosePrice(code: string, date: string): Promise<number | null>;

  /**
   * 获取单只股票指定日期昨收
   * 停牌返回 null
   */
  getPrevClose(code: string, date: string): Promise<number | null>;

  /**
   * 获取单只股票指定日期开盘价
   * 停牌返回 null
   */
  getTodayOpen(code: string, date: string): Promise<number | null>;
}
