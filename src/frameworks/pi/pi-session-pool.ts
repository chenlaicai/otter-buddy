/**
 * PiSessionPool —— pi AgentSession 的通用 LRU 会话池（F20260911pspl）
 *
 * 定位：与宿主无关的 pi session 生命周期管理设施——池不知道"对话/房间/协作机制"，
 * 只知道 key → AgentSession 的拉起、保活、驱逐。
 *
 * 设计要点：
 * - acquire(key)：池命中直接返回；未命中调用注入的 factory 重建（jsonl 恢复由 factory 内
 *   SessionManager.open 完成，池不感知）。
 * - 保活：每次 acquire 刷新 lastTouched（LRU 语义）。
 * - 驱逐：周期扫描，idle 超 TTL 且非 running → dispose 出池。running 判定优先用注入的
 *   isBusy 谓词；未注入时回退 AgentSession.isStreaming（SDK 自有状态，见
 *   pi-coding-agent agent-session.d.ts）。
 * - 失败语义：factory 抛错 = 该 key 本次拉起失败，不入池、不计 touch（下次 acquire 重试）。
 * - 容量：可选 maxSize LRU 容量驱逐（默认 0 = 不启用，仅时间驱逐）。
 *
 * 并发说明：Node 单进程内使用；acquire 的 async factory 期间同一 key 的并发 acquire
 * 由 inflight Map 去重（同 key 共享同一个拉起 Promise），防双对象挂同一 jsonl。
 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";

export interface PiSessionPoolOptions {
  /** idle 超过该时长即驱逐（默认 10min） */
  ttlMs?: number;
  /** 驱逐扫描周期（默认 60s） */
  sweepIntervalMs?: number;
  /** 容量上限，超出时驱逐最久未触的 idle 项（0 = 不启用，默认 0） */
  maxSize?: number;
  /** 运行中判定（运行中不驱逐）。缺省回退 session.isStreaming */
  isBusy?: (session: AgentSession) => boolean;
  /** 当前时间注入（测试用） */
  now?: () => number;
}

export type PiSessionFactory = (key: string) => Promise<AgentSession>;

interface PoolEntry {
  session: AgentSession;
  lastTouched: number;
}

export class PiSessionPool {
  private readonly entries = new Map<string, PoolEntry>();
  private readonly inflight = new Map<string, Promise<AgentSession>>();
  private readonly ttlMs: number;
  private readonly sweepIntervalMs: number;
  private readonly maxSize: number;
  private readonly isBusy?: (session: AgentSession) => boolean;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** 驱逐/处置事件回调（观测用，可选） */
  onEvict?: (key: string, reason: "ttl" | "lru" | "manual") => void;

  constructor(
    private readonly factory: PiSessionFactory,
    options: PiSessionPoolOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? 10 * 60 * 1000;
    this.sweepIntervalMs = options.sweepIntervalMs ?? 60 * 1000;
    this.maxSize = options.maxSize ?? 0;
    this.isBusy = options.isBusy;
    this.now = options.now ?? (() => Date.now());
  }

  /** 取 session：命中直接返回（并刷新 LRU 时间）；未命中经 factory 拉起入池 */
  async acquire(key: string): Promise<AgentSession> {
    const hit = this.entries.get(key);
    if (hit) {
      hit.lastTouched = this.now();
      return hit.session;
    }
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const p = this.factory(key)
      .then((session) => {
        this.entries.set(key, { session, lastTouched: this.now() });
        this.evictOverflow();
        return session;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  /** 手动驱逐指定 key（如宿主知道该 session 已损坏） */
  evict(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    try { entry.session.dispose(); } catch { /* dispose 失败不阻塞驱逐 */ }
    this.onEvict?.(key, "manual");
    return true;
  }

  /** 池状态查询（名册/观测用） */
  has(key: string): boolean { return this.entries.has(key); }
  get size(): number { return this.entries.size; }
  keys(): string[] { return [...this.entries.keys()]; }

  /** 启动驱逐扫描（幂等） */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), this.sweepIntervalMs);
    this.timer.unref?.();
  }

  /** 停止扫描（不 dispose 池中 session；进程退出请用 disposeAll） */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 全量释放（进程关闭路径） */
  disposeAll(): void {
    this.stop();
    for (const [, entry] of this.entries) {
      try { entry.session.dispose(); } catch { /* 退出路径尽力而为 */ }
    }
    this.entries.clear();
  }

  private busy(entry: PoolEntry): boolean {
    if (this.isBusy) return this.isBusy(entry.session);
    return entry.session.isStreaming;
  }

  private sweep(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (this.busy(entry)) continue; // running 不释放
      if (now - entry.lastTouched > this.ttlMs) {
        this.entries.delete(key);
        try { entry.session.dispose(); } catch { /* dispose 失败不阻塞驱逐 */ }
        this.onEvict?.(key, "ttl");
      }
    }
  }

  /** 容量驱逐：超出 maxSize 时，驱逐最久未触的 idle 项（running 豁免；全员 running 则不驱逐） */
  private evictOverflow(): void {
    if (this.maxSize <= 0) return;
    while (this.entries.size > this.maxSize) {
      let victimKey: string | null = null;
      let victimTouched = Infinity;
      for (const [key, entry] of this.entries) {
        if (this.busy(entry)) continue;
        if (entry.lastTouched < victimTouched) { victimTouched = entry.lastTouched; victimKey = key; }
      }
      if (victimKey === null) return; // 全部 running，放弃容量驱逐
      const victim = this.entries.get(victimKey)!;
      this.entries.delete(victimKey);
      try { victim.session.dispose(); } catch { /* dispose 失败不阻塞驱逐 */ }
      this.onEvict?.(victimKey, "lru");
    }
  }
}
