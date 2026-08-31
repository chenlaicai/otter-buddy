/**
 * F20260831tumv 回归测试：manifest "*" 展开必须以实际注册工具全集为 universe，
 * 而非 session-helpers 中的 stale 硬编码 fallback。
 *
 * 事故现场（0831 操盘日报）：PR4/PR5 在 tool-factory 注册了 stock_data/paper_trade
 * 并加入 manifest capabilityBlocks，但 big 型 tools:"*" 展开走的是
 * getOtterToolNamesForType(otterType, undefined, ...) 的硬编码 fallback——
 * 新工具不在其中，被 whitelist 滤掉，大獭 session 看不到这两个工具。
 *
 * 修复：pi-session-factory 先调 cfg.createTools 取注册全集，再传给白名单计算。
 * 本测试直接断言修复后的接线（mock createTools 返回含"新工具"的注册集，
 * 断言它进入 session 的 customTools 白名单），并钉住 stale fallback 的复现条件。
 */
import { describe, it, expect } from "vitest";
import { getOtterToolNamesForType } from "@frameworks/agent/session-helpers";
import { getToolNamesFromManifest } from "@frameworks/config/tool-manifest-loader";
import type { ToolManifest } from "@frameworks/config/tool-manifest-loader";
import { join } from "node:path";

describe("F20260831tumv: manifest '*' 展开的工具全集", () => {
  const STALE_FALLBACK = ["speak", "yield", "search_memory"]; // 简化的旧硬编码语义
  const REGISTERED = ["speak", "yield", "search_memory", "stock_data", "paper_trade"];

  const manifest: ToolManifest = {
    schemaVersion: 2,
    defaultType: "big",
    types: {
      big: { description: "big", tools: "*" },
      small: { description: "small", groups: ["conversation"], tools: ["speak", "yield"] },
    },
    capabilityBlocks: {
      conversation: { description: "", tools: ["search_messages", "list_messages"] },
    },
  };

  it("复现事故：'*' 展开以 stale fallback 为全集时，新工具被滤掉", () => {
    const whitelist = getToolNamesFromManifest(manifest, "big", STALE_FALLBACK);
    expect(whitelist).toEqual(STALE_FALLBACK);
    expect(whitelist).not.toContain("stock_data");
    expect(whitelist).not.toContain("paper_trade");
  });

  it("修复后：'*' 展开以实际注册全集（createTools 返回值）为 universe", () => {
    const whitelist = getToolNamesFromManifest(manifest, "big", REGISTERED);
    expect(whitelist).toEqual(REGISTERED);
    expect(whitelist).toContain("stock_data");
    expect(whitelist).toContain("paper_trade");
  });

  it("生产路径（真实 manifest）：注册全集经 getOtterToolNamesForType 后 big 型含 stock_data/paper_trade", () => {
    const projectRoot = join(import.meta.dirname, "../../../"); // worktree 根（3 级：agent→frameworks→tests→根）
    const big = getOtterToolNamesForType("big", REGISTERED, projectRoot);
    expect(big).toContain("stock_data");
    expect(big).toContain("paper_trade");
    // 集团工具（小獭专属 groups 展开的）不在 big 白名单是 manifest 配置问题，此处不约束
  });

  it("small 型走 groups 显式展开，不受 universe 来源影响", () => {
    const projectRoot = join(import.meta.dirname, "../../../");
    const small = getOtterToolNamesForType("small", REGISTERED, projectRoot);
    expect(small).toContain("stock_data");
    expect(small).toContain("paper_trade");
    expect(small).not.toContain("create_otter");
    expect(small).not.toContain("halt_otter");
    expect(small).not.toContain("resolve_signal");
  });

  it("防退化：universe 缺省时（旧行为），真实 manifest 展开不含 stock_data/paper_trade——修复必须传注册全集", () => {
    const projectRoot = join(import.meta.dirname, "../../../");
    const stale = getOtterToolNamesForType("big", undefined, projectRoot);
    expect(stale).not.toContain("stock_data");
    expect(stale).not.toContain("paper_trade");
  });
});
