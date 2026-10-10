/**
 * F20261009epoc（#905）：invoke 生命周期统一世代（epoch）值对象 + 独立传播通道。
 *
 * 定位：把分散在四处的「识别动作是否仍属于已死的旧世界」防御（SimpleLockManager
 * generation / 池 markStale / #904 清理归属 / #1241 pid 判据——前三是 invoke 世代，
 * pid 是进程世代不收编）归一为同一处语义定义：invoke 启动时铸造 epoch token，
 * 随 AsyncLocalStorage 传播，锁/池/寄存器/清理钩子只认 token（对象引用相等）。
 * 双活从「各处各自应对的意外」变「一处定义清楚的语义」。
 *
 * 设计要点（方案 D1/D2，特性文档 docs/features/2026/10/09/ 见 F20261009epoc）：
 * - 纯进程内值对象，不持久化——跨进程「复活」物理不可能（进程死 promise 死），
 *   DB 层 pid+bootTs 双判据已兜住跨进程场景（r1-S1 砍持久化）。
 * - 判定一律用对象引用相等（entry.epoch === alsEpoch），不用任何可比较的
 *   标量字段——防「可比较 ID 被复制/伪造」类绕过。seq 仅日志可读性，不参与判定。
 * - Object.freeze（值对象语义完整性，方案未决问题 3 实现期定：冻结）。
 *
 * 为什么是独立 ALS 通道（r2 delta D-1 双 ALS）：
 * - otterInvokeStorage（model-runtime-registry.ts:306）在 :918 装配且含
 *   identityPrefix 构建（DB 查询），不能上移到 invoke() 入口——上移会让
 *   :705 嵌套检查读到自置 store，每个 invoke 被误判嵌套而跳锁、互斥失效。
 * - epoch 必须在锁 acquire（:710）之前可读，故走独立通道早装。
 * - 遮蔽式 run（invoke() 入口判非嵌套后必铸新对象 run）：即使该 store 里
 *   残留可读的外层 epoch 也被遮蔽——「共享 epoch 对象且抢锁」在任何失效
 *   组合（含非对称失效）下不可达，等价性全称成立（r3-E-1，见特性文档 D4）。
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** invoke 世代 token（F20261009epoc D2）。判定用对象引用相等，字段仅观测/日志用。 */
export interface InvokeEpoch {
  readonly invokeId: string;
  readonly mintedAt: number;
  /** 进程内 per-otter 单调计数（重启归零），仅日志可读性，不参与判定 */
  readonly seq: number;
}

/**
 * epoch 传播通道（独立于 otterInvokeStorage——见文件头注释）。
 * 生命周期：pi-session-factory.invoke() 入口铸造（非嵌套）或继承（嵌套）→
 * 随 ALS 到锁 acquire / 池操作 / 寄存器操作 / 清理钩子 → invoke 结束自然消亡。
 */
export const invokeEpochStorage = new AsyncLocalStorage<InvokeEpoch>();

/** 进程内 per-otter 计数器（纯内存，重启归零——seq 仅日志用途，无需持久） */
const seqCounters = new Map<string, number>();

/**
 * 铸造新 epoch（F20261009epoc D4 铸造点：invoke() 入口、锁 acquire 之前）。
 * 每次调用必返回全新对象（冻结）——引用相等判定依赖对象身份唯一性，
 * 禁止任何形式的复用/缓存。
 */
export function mintEpoch(otterId: string, invokeId: string): InvokeEpoch {
  const seq = (seqCounters.get(otterId) ?? 0) + 1;
  seqCounters.set(otterId, seq);
  return Object.freeze({ invokeId, mintedAt: Date.now(), seq }) as InvokeEpoch;
}

/** 测试辅助：清空进程内计数器（跨用例隔离，生产代码不得调用） */
export function __resetEpochCountersForTest(): void {
  seqCounters.clear();
}
