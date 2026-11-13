import { describe, expect, it } from "vitest";
import { createTestDb } from "../../helpers/db";
import { SqliteConversationRepository } from "@frameworks/db/conversation/sqlite-conversation-repository";
import { ManageKeyInfo } from "@usecases/conversation/manage-key-info";
import type { MemoryIndexGateway } from "@usecases/conversation/memory-index-gateway";
import { createArchiveArtifactForReconciliationTool, createUpdateArtifactStatusTool } from "@interface-adapters/agent-runtime/tools/artifact-tools";
import { buildResourceClient } from "../../../src/bootstrap/clients";
import type { ToolContext } from "@usecases/ports/agent-tools";
import type { OtterToolClient } from "@usecases/ports/otter-tool-client";

/**
 * #1835：跨对话机械对账被 conversation 归属闸阻断。
 * 受控对账归档路径（archive_artifact_for_reconciliation）是唯一合法跨对话写入口；
 * 普通 update_artifact_status 对非所属对话仍 404。
 */
describe("archiveResourceForReconciliation（#1835）", () => {
  const RESOURCE_ID = "cb44aec8-b1a3-4616-bff8-8331bd0d3067"; // #1801 真实资源 ID（issue 案发现场）
  const TARGET_CONVERSATION = "a9260c50-cef6-412e-a0b4-282287a13103"; // 资源所属对话
  const OPERATOR_CONVERSATION = "3241317b-99d6-4d78-9248-ff208a7461bc"; // 每日健康检查所在对话

  function buildFixture() {
    const db = createTestDb();
    const now = new Date().toISOString();
    db.prepare("INSERT INTO conversations (id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
      TARGET_CONVERSATION, "target", "active", now, now,
    );
    const repo = new SqliteConversationRepository(db);
    const memoryIndex = { indexLinkedResource: async () => {} } as unknown as MemoryIndexGateway;
    const uc = new ManageKeyInfo(repo, memoryIndex);
    return { db, repo, uc };
  }

  function linkArtifact(repo: SqliteConversationRepository, resourceType = "pr") {
    return repo.linkResource({
      id: RESOURCE_ID,
      conversationId: TARGET_CONVERSATION,
      resourceType,
      url: resourceType === "pr"
        ? "https://github.com/chenlaicai/otter-buddy/pull/1801"
        : "https://example.com/artifact",
      title: resourceType === "pr" ? "PR #1801" : "artifact",
      content: null,
      category: null,
      userFlagged: false,
      metadata: null,
      linkedBy: "test",
      otterId: null,
      autoLinked: false,
      createdAt: new Date().toISOString(),
      status: "active",
      groupId: null,
      supersededBy: null,
      archivedByOtterId: null,
      archivedAt: null,
      archiveEvidence: null,
    });
  }

  function makeTool(uc: ManageKeyInfo, operatorOtterId = "otter-operator"): ReturnType<typeof createArchiveArtifactForReconciliationTool> {
    const client = { resource: buildResourceClient({ manageKeyInfo: uc } as never) } as unknown as OtterToolClient;
    const ctx: ToolContext = {
      client, otterId: operatorOtterId, conversationId: OPERATOR_CONVERSATION, currentMessageId: "msg-1",
    };
    return createArchiveArtifactForReconciliationTool(ctx);
  }

  it("#1801 现场：跨对话 PR 资源在对账路径可归档，审计三列与目标 conversation 均留痕", async () => {
    const { db, repo, uc } = buildFixture();
    try {
      await linkArtifact(repo);

      const result = await uc.archiveResourceForReconciliation({
        artifactId: RESOURCE_ID,
        operatorOtterId: "otter-operator",
        evidence: "gh pr view 1801 --json state → MERGED",
      });

      expect(result.status).toBe("archived");
      expect(result.conversationId).toBe(TARGET_CONVERSATION);
      expect(result.archivedByOtterId).toBe("otter-operator");
      expect(result.archiveEvidence).toContain("MERGED");

      const row = db.prepare(
        "SELECT status, archived_by_otter_id, archived_at, archive_evidence FROM linked_resources WHERE id = ?",
      ).get(RESOURCE_ID) as { status: string; archived_by_otter_id: string | null; archived_at: string | null; archive_evidence: string | null };
      expect(row.status).toBe("archived");
      expect(row.archived_by_otter_id).toBe("otter-operator");
      expect(row.archived_at).toBeTruthy();
      expect(row.archive_evidence).toContain("gh pr view 1801");
    } finally {
      db.close();
    }
  });

  it("非机械可判资源类型（fact）一律拒绝，不写库", async () => {
    const { db, repo, uc } = buildFixture();
    try {
      await linkArtifact(repo, "fact");

      await expect(uc.archiveResourceForReconciliation({
        artifactId: RESOURCE_ID, operatorOtterId: "otter-operator", evidence: "gh pr view 1801 --json state → MERGED",
      })).rejects.toMatchObject({ kind: "validation" });
      expect(db.prepare("SELECT status FROM linked_resources WHERE id = ?").pluck().get(RESOURCE_ID)).toBe("active");
    } finally {
      db.close();
    }
  });

  it("无机器证据拒绝；重复归档按领域终态规则冲突，不产生第二写", async () => {
    const { db, repo, uc } = buildFixture();
    try {
      await linkArtifact(repo);

      await expect(uc.archiveResourceForReconciliation({
        artifactId: RESOURCE_ID, operatorOtterId: "otter-operator", evidence: "   ",
      })).rejects.toMatchObject({ kind: "validation" });

      await uc.archiveResourceForReconciliation({
        artifactId: RESOURCE_ID, operatorOtterId: "otter-operator", evidence: "gh pr view 1801 --json state → MERGED",
      });
      await expect(uc.archiveResourceForReconciliation({
        artifactId: RESOURCE_ID, operatorOtterId: "otter-operator", evidence: "gh pr view 1801 --json state → MERGED",
      })).rejects.toMatchObject({ kind: "conflict" });
    } finally {
      db.close();
    }
  });

  it("工具入口：operator 由 ctx.otterId 注入，跨对话归档成功；普通 update_artifact_status 对非所属对话仍 404", async () => {
    const { db, repo, uc } = buildFixture();
    try {
      await linkArtifact(repo);
      const tool = makeTool(uc, "otter-scheduler");

      const result = await tool.execute("call-1", {
        artifactId: RESOURCE_ID,
        evidence: "gh pr view 1801 --json state → MERGED",
      });
      const payload = JSON.parse(result.content[0].text) as { archivedByOtterId: string; conversationId: string; status: string };
      expect(payload.status).toBe("archived");
      expect(payload.archivedByOtterId).toBe("otter-scheduler");
      expect(payload.conversationId).toBe(TARGET_CONVERSATION);

      // 网关反击（#1835 断言 1）：普通路径对该跨对话资源继续按 404 拒绝
      const client = { resource: buildResourceClient({ manageKeyInfo: uc } as never) } as unknown as OtterToolClient;
      const plainCtx: ToolContext = {
        client, otterId: "otter-other", conversationId: OPERATOR_CONVERSATION, currentMessageId: "msg-2",
      };
      const ordinaryTool = createUpdateArtifactStatusTool(plainCtx);
      await expect(ordinaryTool.execute("call-2", { artifactId: RESOURCE_ID, status: "archived" })).rejects.toMatchObject({ kind: "not_found" });
    } finally {
      db.close();
    }
  });
});