import { describe, it, expect } from "vitest";
import {
  rowToOtter,
  rowToSession,
} from "@frameworks/db/otter/otter-mapper";
import type { OtterRow, SessionRow } from "@frameworks/db/otter/otter-mapper";

describe("rowToOtter", () => {
  const baseRow: OtterRow = {
    id: "otter-1",
    name: "水獭一号",
    type: "big",
    status: "active",
    role_name: null,
    role_responsibilities: null,
    parent_otter_id: null,
    created_at: "2026-01-01T00:00:00Z",
    dissolved_at: null,
  };

  it("将 snake_case 行映射为 camelCase 实体", () => {
    const result = rowToOtter(baseRow);

    expect(result.id).toBe("otter-1");
    expect(result.name).toBe("水獭一号");
    expect(result.type).toBe("big");
    expect(result.status).toBe("active");
    expect(result.parentOtterId).toBeNull();
    expect(result.createdAt).toBe("2026-01-01T00:00:00Z");
    expect(result.dissolvedAt).toBeNull();
  });

  it("role_name 为 null 时 role 为 null", () => {
    const result = rowToOtter(baseRow);
    expect(result.role).toBeNull();
  });

  it("role_name 非 null 但 role_responsibilities 为 null 时，responsibilities 为空数组", () => {
    const row: OtterRow = {
      ...baseRow,
      role_name: "管理者",
      role_responsibilities: null,
    };

    const result = rowToOtter(row);
    expect(result.role).not.toBeNull();
    expect(result.role!.name).toBe("管理者");
    expect(result.role!.responsibilities).toEqual([]);
  });

  it("role_name 和 role_responsibilities 均非 null 时，responsibilities 通过 JSON.parse 解析", () => {
    const row: OtterRow = {
      ...baseRow,
      role_name: "助手",
      role_responsibilities: '["回答问题","整理文档"]',
    };

    const result = rowToOtter(row);
    expect(result.role).not.toBeNull();
    expect(result.role!.name).toBe("助手");
    expect(result.role!.responsibilities).toEqual(["回答问题", "整理文档"]);
  });

  it("dissolved 状态的 otter 有 dissolvedAt 时间", () => {
    const row: OtterRow = {
      ...baseRow,
      status: "dissolved",
      dissolved_at: "2026-06-01T00:00:00Z",
    };

    const result = rowToOtter(row);
    expect(result.status).toBe("dissolved");
    expect(result.dissolvedAt).toBe("2026-06-01T00:00:00Z");
  });

  it("parent_otter_id 非 null 时正确映射", () => {
    const row: OtterRow = {
      ...baseRow,
      parent_otter_id: "parent-otter-1",
    };

    const result = rowToOtter(row);
    expect(result.parentOtterId).toBe("parent-otter-1");
  });
});

describe("rowToSession", () => {
  const baseRow: SessionRow = {
    id: "sess-1",
    otter_id: "otter-1",
    status: "active",
    started_at: "2026-01-01T00:00:00Z",
    archived_at: null,
    archive_reason: null,
    is_negative_case: 0,
    summary: null,
    previous_session_id: null,
    handoff_summary: null,
  };

  it("将 snake_case 行映射为 camelCase 会话实体", () => {
    const result = rowToSession(baseRow);

    expect(result.id).toBe("sess-1");
    expect(result.otterId).toBe("otter-1");
    expect(result.status).toBe("active");
    expect(result.startedAt).toBe("2026-01-01T00:00:00Z");
    expect(result.archivedAt).toBeNull();
    expect(result.archiveReason).toBeNull();
    expect(result.previousSessionId).toBeNull();
    expect(result.summary).toBeNull();
  });

  it("is_negative_case: 1 转为 true", () => {
    const row: SessionRow = { ...baseRow, is_negative_case: 1 };
    const result = rowToSession(row);
    expect(result.isNegativeCase).toBe(true);
  });

  it("is_negative_case: 0 转为 false", () => {
    const result = rowToSession(baseRow);
    expect(result.isNegativeCase).toBe(false);
  });

  it("handoff_summary 为字符串时 JSON.parse 解析为对象", () => {
    const summary = {
      conversationId: "conv-1",
      sessionSequence: 2,
      keyDecisions: ["决定使用新方案"],
      pendingTasks: ["完成测试"],
      activeContext: "正在开发功能",
      participantStatus: { "otter-1": "active" },
    };
    const row: SessionRow = {
      ...baseRow,
      handoff_summary: JSON.stringify(summary),
    };

    const result = rowToSession(row);
    expect(result.handoffSummary).toEqual(summary);
  });

  it("handoff_summary 为 null 时返回 null", () => {
    const result = rowToSession(baseRow);
    expect(result.handoffSummary).toBeNull();
  });

  it("归档的会话有 archivedAt 和 archiveReason", () => {
    const row: SessionRow = {
      ...baseRow,
      status: "archived",
      archived_at: "2026-02-01T00:00:00Z",
      archive_reason: "用户主动归档",
    };

    const result = rowToSession(row);
    expect(result.status).toBe("archived");
    expect(result.archivedAt).toBe("2026-02-01T00:00:00Z");
    expect(result.archiveReason).toBe("用户主动归档");
  });

  it("有前序会话时 previousSessionId 正确映射", () => {
    const row: SessionRow = {
      ...baseRow,
      previous_session_id: "sess-0",
    };

    const result = rowToSession(row);
    expect(result.previousSessionId).toBe("sess-0");
  });
});
