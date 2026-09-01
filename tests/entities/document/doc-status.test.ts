import { describe, it, expect } from "vitest";
import {
  classifyDocStatus,
  classifyDocStatusWithSubstatus,
  IN_FLIGHT_DOC_STATUSES,
  TERMINAL_DOC_STATUSES,
} from "@entities/document/doc-status";
import { KNOWN_FEATURE_STATUSES } from "@entities/document/known-values";

describe("#646 值域契约 classifyDocStatus", () => {
  it("在途值：draft/proposed/design/development/active/review/reviewed → in-flight", () => {
    for (const s of ["draft", "proposed", "design", "development", "active", "review", "reviewed"]) {
      expect(classifyDocStatus(s)).toBe("in-flight");
    }
  });

  it("终态值：locked/final/implemented/archived → terminal", () => {
    for (const s of ["locked", "final", "implemented", "archived"]) {
      expect(classifyDocStatus(s)).toBe("terminal");
    }
  });

  it("缺省（null/undefined）→ in-flight（与 chain-builder 原 ?? 'draft' 行为一致）", () => {
    expect(classifyDocStatus(null)).toBe("in-flight");
    expect(classifyDocStatus(undefined)).toBe("in-flight");
  });

  it("未知值 → unknown（「未知值不碰」契约的入口）", () => {
    for (const s of ["wip", "blocked", "done", "shipped", "released", ""]) {
      expect(classifyDocStatus(s)).toBe("unknown");
    }
  });

  it("防御性 trim：行内注释被 yaml 剥离后万一夹带空白仍可命中已知值", () => {
    expect(classifyDocStatus(" implemented ")).toBe("terminal");
    expect(classifyDocStatus("  development  ")).toBe("in-flight");
  });

  it("契约完整性：在途∪终态 ⊆ KNOWN_FEATURE_STATUSES ∪ {review, reviewed}", () => {
    const known = new Set<string>(KNOWN_FEATURE_STATUSES);
    known.add("review");
    known.add("reviewed");
    for (const s of [...IN_FLIGHT_DOC_STATUSES, ...TERMINAL_DOC_STATUSES]) {
      expect(known.has(s)).toBe(true);
    }
  });

  it("契约完整性：在途 ∩ 终态 = ∅（无值双归属）", () => {
    for (const s of IN_FLIGHT_DOC_STATUSES) {
      expect(TERMINAL_DOC_STATUSES.has(s)).toBe(false);
    }
  });

  it("契约完整性：KNOWN_FEATURE_STATUSES 全部值都有归属（无已知值落入 unknown）", () => {
    // 若 known-values 新增值而 doc-status 没同步分组，此用例先炸（模块加载时自检只防单向漂移）
    for (const s of KNOWN_FEATURE_STATUSES) {
      expect(classifyDocStatus(s)).not.toBe("unknown");
    }
  });
});

// ===== #646 段2：子状态 =====

describe("#646 子状态 classifyDocStatusWithSubstatus", () => {
  it("implemented + substatus:active → in-flight（迭代中，参与病态判定）", () => {
    expect(classifyDocStatusWithSubstatus("implemented", "active")).toBe("in-flight");
  });

  it("纯 implemented（无/空子状态）→ terminal（豁免，合入即完成语义）", () => {
    expect(classifyDocStatusWithSubstatus("implemented", null)).toBe("terminal");
    expect(classifyDocStatusWithSubstatus("implemented", undefined)).toBe("terminal");
    expect(classifyDocStatusWithSubstatus("implemented", "")).toBe("terminal");
  });

  it("子状态对 final/locked/archived 无效（真终态，子状态忽略）", () => {
    expect(classifyDocStatusWithSubstatus("final", "active")).toBe("terminal");
    expect(classifyDocStatusWithSubstatus("locked", "active")).toBe("terminal");
    expect(classifyDocStatusWithSubstatus("archived", "active")).toBe("terminal");
  });

  it("子状态对 in-flight 基础值无效（draft 等本来就是 in-flight，子状态无意义）", () => {
    expect(classifyDocStatusWithSubstatus("development", "active")).toBe("in-flight");
    expect(classifyDocStatusWithSubstatus("development", null)).toBe("in-flight");
  });

  it("子状态对 unknown 基础值无效（不碰原则同样适用于子状态域）", () => {
    expect(classifyDocStatusWithSubstatus("wip", "active")).toBe("unknown");
  });

  it("子状态未知值忽略：implemented + substatus:paused → 仍 terminal", () => {
    expect(classifyDocStatusWithSubstatus("implemented", "paused")).toBe("terminal");
  });

  it("子状态防御性 trim", () => {
    expect(classifyDocStatusWithSubstatus("implemented", " active ")).toBe("in-flight");
  });
});
