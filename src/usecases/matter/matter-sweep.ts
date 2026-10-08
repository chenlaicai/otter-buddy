import type { MatterLevel, MatterState } from '@entities/matter/matter';
import type { MatterRepository } from './matter-repository';

/**
 * MatterSweep——未闭环扫描升格的数据源 usecase（F20261008mlp3 P3）。
 *
 * 背景：prompts/scheduled/未闭环扫描.md 此前是「search_memory 捞回头再说」文本启发式
 * （#1053 9/20 后未改——P1 承诺的日巡小改是漏项）。P3 升格为确定性查询：
 * 扫描跑在三省吾身对话，但 matters 表全局共享——本 usecase 提供跨对话只读扫描。
 *
 * 停滞定义（方案 §7 P3）：OPEN 无人认领 / WAITING_PARTNER 积压——跨日未收尾（24h 基准）。
 * 提醒语义：让等待有声（含短锚+等待时长+等谁的什么动作），不是催办不是自动处置。
 */

/** 停滞 matter（含等待时长，供提醒模板拼装） */
export interface MatterSweepStall {
  id: string;
  conversationId: string;
  title: string;
  ownerOtterId: string | null;
  level: MatterLevel | null;
  state: MatterState;
  waitingOn: string | null;
  waitingFor: string | null;
  createdAt: string;
  updatedAt: string;
  /** 距 updated_at 的小时数（跨日未收尾的量化呈现） */
  stalledHours: number;
}

/** 漏登记的 L2 待裁决项兜底（yield entry，超阈未登记 matter） */
export interface MatterSweepStalledRow {
  id: string;
  conversationId: string;
  createdAt: string;
  senderId: string | null;
  senderName: string;
  yieldTargets: string | null;
  body: string | null;
  /** 去重键：matter 登记时 origin_message_id = yield entry id（P1 准入路径 1 锁定） */
  originMessageId: string;
  /** 已登记的 matter ID（NULL = 未登记——SQL LEFT JOIN 已过滤，恒为 NULL，保留字段供未来扩展） */
  registeredMatterId: string | null;
}

/** 扫描结果汇总 */
export interface MatterSweepResult {
  stalled: MatterSweepStall[];
  /** 超阈 yield 条目（候选漏登记——调用方按 originMessageId 去重后决定补登记） */
  unregisteredYields: MatterSweepStalledRow[];
  scannedAt: string;
}

/** 24h 基准（方案 §3 跨日未收尾；阈值常量集中在此，便于后续调整） */
const STALL_THRESHOLD_HOURS = 24;

export class MatterSweep {
  constructor(private readonly repo: MatterRepository) {}

  /**
   * 执行扫描：停滞 matter + 漏登记 yield 兜底。
   * @param now 当前时间（ISO，测试可注入）
   * @param yieldLookbackDays yield 兜底回看天数（默认 7 天——漏登记不会跨周仍高频提醒）
   */
  async execute(now: Date, yieldLookbackDays = 7): Promise<MatterSweepResult> {
    const nowIso = now.toISOString();
    const stallThreshold = new Date(now.getTime() - STALL_THRESHOLD_HOURS * 3_600_000).toISOString();
    const yieldSince = new Date(now.getTime() - yieldLookbackDays * 24 * 3_600_000).toISOString();

    const stalled = await this.repo.stalledOpen(nowIso, stallThreshold);
    const unregisteredYields = await this.repo.unregisteredYieldsToUser(yieldSince);

    return { stalled, unregisteredYields, scannedAt: nowIso };
  }
}
