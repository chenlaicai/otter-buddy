/**
 * Dispatch Ledger - 派工台账（F20260821i336）
 *
 * Why: 派工状态只存在于对话上下文中（pendingDispatches），没有结构化台账。
 * "从未完成的排查"被汇报成"进行中"（8/19《issue处理》#309/#306 实例）。
 * 台账持久化到 DB，大獭汇报前可核对，消灭状态虚报。
 *
 * 设计依据：R20260817arnt Q2 tool-factory 领域规则下沉
 */

import type { OtterToolClient } from "@usecases/ports/otter-tool-client";

/** 派工记录状态 */
export type DispatchStatus = "pending" | "in_progress" | "completed" | "failed";

/** 派工记录 */
export interface DispatchRecord {
  id: string;
  conversationId: string;
  otterId: string;
  otterName: string;
  task: string;
  status: DispatchStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  resultPr?: string;
  resultSummary?: string;
}

/**
 * 创建派工记录。
 * 在 create_otter 工具执行时调用，记录派工意图。
 */
export async function createDispatchRecord(
  client: OtterToolClient,
  params: {
    conversationId: string;
    otterId: string;
    otterName: string;
    task: string;
  },
): Promise<DispatchRecord> {
  const result = await client.dispatch.createRecord(params);
  const now = new Date().toISOString();

  return {
    id: result.id,
    conversationId: params.conversationId,
    otterId: params.otterId,
    otterName: params.otterName,
    task: params.task,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 更新派工记录状态。
 * 在 yield 回来时调用，更新任务状态。
 */
export async function updateDispatchRecord(
  client: OtterToolClient,
  params: {
    otterId: string;
    conversationId: string;
    status: DispatchStatus;
    resultPr?: string;
    resultSummary?: string;
  },
): Promise<void> {
  await client.dispatch.updateRecord(params);
}

/**
 * 查询派工记录。
 * 大獭汇报前可核对，消灭状态虚报。
 */
export async function queryDispatchRecords(
  client: OtterToolClient,
  params: {
    conversationId: string;
    status?: DispatchStatus;
    otterId?: string;
  },
): Promise<DispatchRecord[]> {
  return client.dispatch.queryRecords(params);
}
