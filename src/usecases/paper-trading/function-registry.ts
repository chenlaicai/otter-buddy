/**
 * 纸面交易函数注册表
 * 
 * 注册可由 function executor 调用的纯代码函数（无 LLM 会话）
 * 
 * PR4: 撮合任务使用 function executor，不创建 agent 会话
 */

export type PaperTradingFunction = (params: Record<string, unknown>) => Promise<Record<string, unknown>>;

export class FunctionRegistry {
  private functions = new Map<string, PaperTradingFunction>();

  /** 注册函数 */
  register(name: string, fn: PaperTradingFunction): void {
    this.functions.set(name, fn);
  }

  /** 执行函数 */
  async execute(name: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const fn = this.functions.get(name);
    if (!fn) {
      throw new Error(`Function not found: ${name}`);
    }
    return fn(params);
  }

  /** 检查函数是否存在 */
  has(name: string): boolean {
    return this.functions.has(name);
  }

  /** 获取所有注册的函数名 */
  getRegisteredFunctions(): string[] {
    return Array.from(this.functions.keys());
  }
}

/** 全局函数注册表实例 */
export const paperTradingFunctionRegistry = new FunctionRegistry();
