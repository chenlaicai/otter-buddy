/**
 * F20260902sgp2 S1：信号协议 v2 派发台账。
 * pending := 已投递 ∧ 无派发记录；消费 = 派发尝试记账（链引擎插桩）。
 * 表结构在 schema.ts createDispatchAttemptsTable 创建（幂等 CREATE IF NOT EXISTS，
 * 遵循 F20260827mgux 消灭誊抄结构——新表只登记 initSchema 一处）。
 */
export interface DispatchAttempt {
  id: string;
  conversationId: string;
  messageId: string;
  targetOtterId: string;
  /** in_progress | completed | failed | aborted */
  status: "in_progress" | "completed" | "failed" | "aborted";
  /** chain | router | retry | backfill | dissolve（F20260904schf P2：出站清算墓碑） */
  source: "chain" | "router" | "retry" | "backfill" | "dissolve";
  attemptStartedAt: string;
  /** 起跑记账时尚未结束，允许缺省（recordStart 不传）；settle 时由 repo 写入 */
  attemptFinishedAt?: string | null;
  note: string | null;
}

export interface PendingSignalRow {
  messageId: string;
  conversationId: string;
  targetOtterId: string;
  signalLevel: string | null;
  createdAt: string;
}

/** 依赖接口：DispatchChainEngine 插桩 + S2 路由器 pending 查询共用（判据单一真相源，§4.3） */
export interface DispatchAttemptRepo {
  /**
   * 起跑记账：INSERT OR REPLACE（幂等；覆盖前压缩旧行前情进 note，§8.2 折中——历史是排查线索）。
   * try/catch 责任在调用方（插桩失败仅日志，绝不阻断链路——硬约束 1）。
   */
  recordStart(attempt: DispatchAttempt): void;
  /** settle 记账：completed/failed/aborted。
   *  F20260904ldgr（#795）：note 参数为追加语义（非覆盖）——新内容以 "; " 拼接在既有
   *  note 之后，前情链在 retry 失败等多次 finish 场景下完整保留（审计取证通道）。 */
  recordFinish(messageId: string, targetOtterId: string, status: "completed" | "failed" | "aborted", note?: string | null): void;
  /** F20260904ldgr（#798 发现 2）：终态行追加备注——invoke fulfilled 但行级出处查库
   *  失败时，在已 completed 的槽位上标记「出处降级」，yield 路由信息丢失不再无痕。
   *  只改 note 不改 status（pending 反连接不变量不可破坏）。失败由调用方日志兜底。 */
  appendNote(messageId: string, targetOtterId: string, note: string): void;
  /**
   * S1 backfill 墓碑（§4.5）：所有存量已投递消息 × otter 目标一次性标记 legacy-attempted。
   * 切换瞬间 pending=0——多獭稳态滞后（rbsg 事故主因）在墓碑一刀之下。
   */
  backfillLegacyAttempted(): number;
  /**
   * S1 观测端点用（§7 观察窗口）：pending 计数 + 明细。
   * 判据 = §4.3 SQL（completed ∧ 非 system ∧ tsp 含 otter 非 user 非自指 ∧ c.status=active ∧ 无 attempt 记录）。
   */
  countPendingSignals(conversationId?: string): number;
  listPendingSignals(conversationId?: string, limit?: number): PendingSignalRow[];
  /** F20260903damp 阻尼#1：同 (message,target) 最小点火间隔守卫。
   *  @returns true = 阻尼中（距上次点火不足 minIntervalSec，应跳过）；false = 允许点火。 */
  shouldThrottle(messageId: string, targetOtterId: string, minIntervalSec: number): boolean;
  /** F20260902sgp2 S4b 看门狗：锚点消息的全部 attempt 是否已到终态（无 in_progress）。
   *  true=链收工；false=有在途派发（链活跃）；无任何行 = false（保守：等消息层判定）。
   *  判定失败/无数据由调用方回退消息存在性判定（SchedulerService 看门狗语义）。 */
  allAnchorAttemptsSettled(messageId: string): boolean;
  /** F20260903dmpe 阻尼#4（S4 补丁批）：dissolve 事务内销账——某獭名下全部
   *  in_progress 派发落 failed（'目标已解散'）。返回翻篇行数。 */
  failAllInProgressForOtter(otterId: string): number;
  /** F20260904schf P2（#792）：dissolve 出站清算——该獭已发出的 completed 消息，
   *  tsp 指向 active 目标且从未记账的槽位，补 aborted/dissolve 墓碑。
   *  发言人已解散，其 yield 信号永不派发；不补则槽位永久 pending（僵尸信号）。
   *  判据与 pendingClause 同源（见实现），归档会话也补（墓碑宁多勿少，同 backfill 偏置）。
   *  返回补账行数。 */
  abortUnattemptedOutgoingForOtter(otterId: string): number;
  /**
   * S1b 轨迹 UI（§4.7）：本会话全部 attempt（无 limit——轨迹批量投影用，
   * (message,target) 唯一键防膨胀；与 pendingClause 同文件同真相源）。
   */
  listAttemptsForConversation(conversationId: string): DispatchAttempt[];
  /**
   * K2 收件箱预告（F20260903k23，#757 审视焦点 1 修复）：目标獭的 pending 精确计数
   * （pendingClause 同源 + target 过滤，无 limit——预告数字必须诚实，不准的预告比
   * 没有预告更糟）。HALT 计数一次查询带回（预告的「优先处理」注明用）。
   */
  countPendingForTarget(conversationId: string, targetOtterId: string): { total: number; halt: number };
  /**
   * F202609048840 F4：按 (messageId, targetOtterId) 精确查单行——resume done 语义判定的
   * 真相源。链引擎对 invoke 拒绝是 allSettled 吞错语义（#599：processHopResults 只记日志
   * 不上抛），executeChain 正常返回 ≠ invoke 成功；台账 settle 终态才是准确判据。
   * 无行（记账链路异常）返回 null，调用方保守判成功（不因观测缺失误标 failed）。
   */
  getAttempt(messageId: string, targetOtterId: string): DispatchAttempt | null;
  /**
   * 启动死亡证明（§4.4，flash 对撞③）：进程内不可能有存活的 in_progress 跨越重启——
   * 补扫之前把所有 in_progress 标 failed + note。先例 reconcile-orphans.ts:50 同款语义。
   * 返回翻篇行数（日志可见）。
   */
  markStaleInProgressFailed(): number;
}
