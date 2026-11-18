/**
 * F20261118bltls P1c：belief 状态迁移 usecase（verify/reject/supersede 共用）。
 *
 * 只做「已存在 belief 的 metadata.status 原地迁移」——不新建条目、不删条目（v4 硬约束 1），
 * 迁移合法性走 belief-guard 的 isLegalBeliefTransition 纯函数；写回走
 * MemoryWriter.replaceEntryBySource 的同 id 快路径（UPDATE 本行，id/边/权重不变）。
 */
import type { BeliefStatus } from "@entities/memory/belief";
import { parseBeliefMetadata } from "@entities/memory/belief";
import { isLegalBeliefTransition } from "./belief-guard";
import type { MemoryEntry } from "@entities/memory/memory-entry";
import { DomainError } from "@entities/errors";

export interface TransitionBeliefInput {
  /** 目标 belief 条目 ID */
  entryId: string;
  /** 目标状态（合法迁移矩阵由 isLegalBeliefTransition 锁死） */
  to: BeliefStatus;
}

export interface TransitionBeliefPorts {
  getEntryById(id: string): Promise<MemoryEntry | null>;
  /** 同 id 原地替换（UPDATE 本行）——belief sourceId==id，replaceEntryBySource 走快路径 */
  replaceEntry(entry: MemoryEntry): Promise<{ embeddingKept: boolean }>;
}

export interface TransitionBeliefResult {
  entryId: string;
  from: BeliefStatus;
  to: BeliefStatus;
}

export class TransitionBelief {
  constructor(private readonly ports: TransitionBeliefPorts) {}

  async execute(input: TransitionBeliefInput): Promise<TransitionBeliefResult> {
    const entry = await this.ports.getEntryById(input.entryId);
    if (!entry) {
      throw new DomainError(`belief 条目 ${input.entryId} 不存在`, "not_found");
    }
    if (entry.contentType !== "belief") {
      throw new DomainError(
        `条目 ${input.entryId} 不是 belief（contentType=${entry.contentType}），不能做 belief 状态迁移`,
        "validation",
      );
    }
    const belief = parseBeliefMetadata(entry);
    if (!belief) {
      throw new DomainError(
        `belief 条目 ${input.entryId} 的 metadata 不合法（缺 kind/status/anchors 或字段形态错误），拒绝迁移`,
        "validation",
      );
    }
    if (belief.status === input.to) {
      // 幂等：目标状态已就位，不重复写库（superseded 终态重复打回安全）
      return { entryId: input.entryId, from: belief.status, to: input.to };
    }
    if (!isLegalBeliefTransition(belief.status, input.to)) {
      throw new DomainError(
        `belief 状态迁移非法：${belief.status} → ${input.to}`,
        "validation",
      );
    }

    const updated: MemoryEntry = {
      ...entry,
      metadata: { ...entry.metadata, status: input.to },
    };
    await this.ports.replaceEntry(updated);
    return { entryId: input.entryId, from: belief.status, to: input.to };
  }
}
