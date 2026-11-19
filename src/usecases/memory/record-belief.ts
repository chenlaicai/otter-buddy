/**
 * P1a：主动记忆层（belief）写入路径。
 *
 * 现场记录的主要入口（otter-memory-design v4）：
 * 1. BeliefGuard 四维出处校验（空/不存在/身份不符 = 拒收）；
 * 2. 通过后走 StoreMemory.execute 复用现有防线（污染拦截 + 嵌入 + FTS）。
 * 新条目一律以 status=recorded 出生（初态 [未核实]，权重低于 verified——见 P1b 检索端）。
 */
import type { BeliefKind } from "@entities/memory/belief";
import { DomainError } from "@entities/errors";
import type { BeliefGuard } from "./belief-guard";
import type { MemoryEntryInput } from "./store-memory";

export interface RecordBeliefInput {
  kind: BeliefKind;
  content: string;
  /** 出处锚点（四维校验 1/2/3）：本 belief 依据的原始消息/文档条目 ID */
  anchors: string[];
  /** state（推断类）必填：推断依据条目 ID（四维校验 4） */
  inferredFrom?: string[];
  /** 即时 supersede（现场纠错）：被本 belief 取代的旧 belief 条目 ID（防环校验） */
  supersedes?: string;
  conversationId: string;
  /** 本对话搭档（用户）id——preference 来源身份校验用 */
  partnerUserId: string;
}

/** 写入端口（窄接口）：生产实现为 StoreMemory（复用污染拦截+嵌入+FTS）；测试可 fake */
export interface BeliefStore {
  execute(input: MemoryEntryInput): Promise<string>;
}

export class RecordBelief {
  constructor(
    private readonly guard: BeliefGuard,
    private readonly store: BeliefStore,
  ) {}

  async execute(input: RecordBeliefInput): Promise<{ entryId: string }> {
    const validation = await this.guard.validate({
      kind: input.kind,
      status: "recorded",
      content: input.content,
      anchors: input.anchors,
      inferredFrom: input.inferredFrom,
      supersedes: input.supersedes,
      conversationId: input.conversationId,
      partnerUserId: input.partnerUserId,
    });

    if (!validation.ok) {
      throw new DomainError(
        `belief 出处校验未通过：${validation.errors.map((e) => e.message).join("；")}`,
        "validation",
      );
    }

    const entryId = crypto.randomUUID();
    const metadata = {
      kind: input.kind,
      status: "recorded" as const,
      anchors: input.anchors,
      ...(input.inferredFrom !== undefined ? { inferredFrom: input.inferredFrom } : {}),
      ...(input.supersedes !== undefined ? { supersedes: input.supersedes } : {}),
    };

    await this.store.execute({
      layer: "working",
      contentType: "belief",
      sourceId: entryId,
      sourceTable: "belief",
      conversationId: input.conversationId,
      granularity: "coarse",
      content: input.content,
      metadata,
    });

    return { entryId };
  }
}