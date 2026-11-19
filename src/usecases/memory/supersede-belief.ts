/**
 * P1c：belief supersede usecase（标记过期 / 新 belief 取代旧 belief）。
 *
 * 两条路径：
 * - markExpired(oldId)：夜间审视獭「标记过期」——旧条目迁 superseded，不建边（无新条目）。
 * - markReplaced(oldId, newId)：现场「写入带 supersedes 提议」——旧条目迁 superseded，
 * 并建 supersedes 边（from=new 取代者，to=old 被取代；检索端据此降权 + get_related 可拼链）。
 *
 * TOCTOU 防护（P1c 前瞻已知项）：markReplaced 建边前先查 old 是否已有入边 supersedes
 * （getSupersededBy 命中=已被取代）——已取代则跳过建边与迁移（幂等），防并发双写把
 * 两个新条目都建边指向同一旧条目（A→B、C→B 双取代者并存）。
 */
import type { MemoryEntry } from "@entities/memory/memory-entry";
import { DomainError } from "@entities/errors";
import type { TransitionBelief } from "./transition-belief";

export interface SupersedeBeliefPorts {
  /** 查哪些条目已被 supersedes 边指向（同源 Map<旧,新>） */
  getSupersededBy(entryIds: string[]): Promise<Map<string, string>>;
  /** 建 supersedes 边（from=取代者，to=被取代） */
  createEdge(input: {
    fromEntryId: string;
    toEntryId: string;
    edgeType: "supersedes";
    createdBy?: string;
  }): Promise<string>;
  /** 读取条目（TOCTOU 前置检查用——校验 new 存在且为 belief，防把边建到非 belief） */
  getEntryById(id: string): Promise<MemoryEntry | null>;
}

export interface SupersedeBeliefResult {
  entryId: string;
  newEntryId?: string;
  edgeId?: string;
  /** 幂等命中：old 已被取代（边已存在），未重复建边/迁移 */
  alreadySuperseded?: boolean;
}

export class SupersedeBelief {
  constructor(
    private readonly ports: SupersedeBeliefPorts,
    private readonly transition: TransitionBelief,
  ) {}

  /** 标记过期（无新条目）：旧 belief → superseded（幂等） */
  async markExpired(oldEntryId: string): Promise<SupersedeBeliefResult> {
    await this.transition.execute({ entryId: oldEntryId, to: "superseded" });
    return { entryId: oldEntryId };
  }

  /** 新 belief 取代旧 belief：旧 → superseded + 建边 from=new, to=old */
  async markReplaced(oldEntryId: string, newEntryId: string, createdBy?: string): Promise<SupersedeBeliefResult> {
    // TOCTOU 防护：old 已有入边 supersedes（已被取代）→ 幂等跳过，不再建第二条边
    const supersededBy = await this.ports.getSupersededBy([oldEntryId]);
    if (supersededBy.has(oldEntryId)) {
      return { entryId: oldEntryId, newEntryId, alreadySuperseded: true };
    }

    // 新条目存在且为 belief（防把边建到脏 ID 上）
    const newEntry = await this.ports.getEntryById(newEntryId);
    if (!newEntry || newEntry.contentType !== "belief") {
      throw new DomainError(`supersede 新条目 ${newEntryId} 不存在或不是 belief，拒绝建边`, "validation");
    }

    await this.transition.execute({ entryId: oldEntryId, to: "superseded" });
    const edgeId = await this.ports.createEdge({
      fromEntryId: newEntryId,
      toEntryId: oldEntryId,
      edgeType: "supersedes",
      createdBy,
    });
    return { entryId: oldEntryId, newEntryId, edgeId };
  }
}
