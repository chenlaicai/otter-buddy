/**
 * 定时任务 function executor 函数注册表
 *
 * 注册可由 function executor（executorType='function'）调用的纯代码函数（无 LLM 会话）。
 * F20260920stkx：随 paper-trading 能力移除，原 @usecases/paper-trading/function-registry
 * 迁至 scheduler 域——function executor 是 scheduler 通用机制（schema executor_type 列、
 * mapper、核心循环均支持），不随单一消费者退役。
 */

export type ExecutorFunction = (params: Record<string, unknown>) => Promise<Record<string, unknown>>;

export class FunctionRegistry {
  private functions = new Map<string, ExecutorFunction>();

  /** 注册函数 */
  register(name: string, fn: ExecutorFunction): void {
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


