/**
 * F20261008gdcc P1 项 4：generate-guard-replay.mjs 单测。
 *
 * 脚本职责：前日 guard_intercept 事件 → replay 候选 JSON（裁决前置的机械部分：
 * 按日筛选、commandHead/reason 反查、ruleId 分类、脱敏、去重）。期望值裁决是人工/獭审
 * 职责，不在脚本范围——本测试验证机械部分正确性。
 *
 * 策略：临时 sqlite 文件库（建 healing_events 最小 schema），种子事件走子进程跑脚本，
 * 断言产出 JSON。覆盖：正常提取、日期窗过滤、无命令前缀容错、去重、context 缺失分类兜底、
 * db 缺失退出码 2。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createTestDb } from "../helpers/db";
const repoRoot = resolve(import.meta.dirname, "../..");
const scriptPath = join(repoRoot, "scripts/generate-guard-replay.mjs");

let tmpDir: string;
let dbPath: string;
let outDir: string;

/** 昨日/前日 ISO 日期串（本地时区，与脚本同口径） */
function localDate(offsetDays: number): string {
  const d = new Date(Date.now() + offsetDays * 24 * 3600 * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const SCHEMA = "(由 createTestDb 生产 schema 工厂建表——禁手写 DDL，lint-tests 硬规则)"; void SCHEMA;

interface SeedEvent {
  id: string;
  errorType: string;
  description: string;
  context: unknown;
  createdAt: string;
}

function seedEvent(e: SeedEvent): string {
  return `INSERT INTO healing_events (id, message_id, conversation_id, otter_id, error_type, severity, description, context, created_at)
    VALUES ('${e.id}', 'm1', 'c1', 'otter-1', '${e.errorType}', 'medium', '${e.description.replace(/'/g, "''")}', '${typeof e.context === "string" ? e.context : JSON.stringify(e.context).replace(/'/g, "''")}', '${e.createdAt}')`;
}

/** 产一条 pi-session-factory 落账口径的 guard_intercept 事件 */
function structuredEvent(id: string, createdAt: string, commandHead: string, ruleId: string, ruleLayer: string): SeedEvent {
  return {
    id,
    errorType: "guard_intercept",
    description: `bash 守卫拦截（近 6h 第 1 次）：reason-text-${id}（命令前缀：${commandHead}）`,
    context: { layer: "framework", ruleId, ruleLayer, commandHead, hasWorktreePath: commandHead.includes("/worktrees/") },
    createdAt,
  };
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "guard-replay-test-"));
  dbPath = join(tmpDir, "test.db");
  outDir = join(tmpDir, "out");
  mkdirSync(outDir, { recursive: true });
  // 文件库（非内存）：被测脚本独立进程打开同一文件，内存库跨进程不可见。
  // 生产 schema 工厂（lint-tests 硬规则）——含 healing_events 表与迁移补丁列
  const db = createTestDb(dbPath);
  const y = localDate(-1); // 昨日（脚本默认窗）
  const y2 = localDate(-2); // 前日（窗外对照）
  const seeds: SeedEvent[] = [
    structuredEvent("s1", `${y}T03:00:00.000Z`, "cd /repo/wt && git commit -m x", "main_write", "r1_gate"),
    // 同 ruleId 同命令头 → 应被去重
    structuredEvent("s2", `${y}T04:00:00.000Z`, "cd /repo/wt && git commit -m x", "main_write", "r1_gate"),
    // 同命令头异 ruleId → 不去重（规则维度不同，裁决价值不同）
    structuredEvent("s3", `${y}T05:00:00.000Z`, "cd /repo/wt && git commit -m x", "self_kill_literal", "self_kill"),
    // 窗外（前日）→ 不入候选
    structuredEvent("s4", `${y2}T03:00:00.000Z`, "cd /repo/wt && git status", "main_write", "r1_gate"),
    // 非 guard_intercept → 不入候选
    { id: "s5", errorType: "tool_error", description: "unrelated", context: {}, createdAt: `${y}T03:00:00.000Z` },
    // 旧格式：context 无 ruleId、description 无命令前缀 → 审视处置（#1368 §3.3）
    // 后 SQL 层直接排除（无 ruleId 且无命令前缀 = 无法裁决的纯噪声，如 bounce 计数事件）
    { id: "s6", errorType: "guard_intercept", description: "旧格式自由文本无命令前缀", context: {}, createdAt: `${y}T06:00:00.000Z` },
    // description 反查路径：context 缺 commandHead 但 description 有命令前缀
    {
      id: "s7", errorType: "guard_intercept",
      description: "bash 守卫拦截（近 6h 第 2 次）：reason-x（命令前缀：cd /repo/wt && ls | grep -E \"probe|gate\"）",
      context: { ruleId: "data_destructive", ruleLayer: "r1_gate" },
      createdAt: `${y}T07:00:00.000Z`,
    },
  ];
  for (const s of seeds) db.exec(seedEvent(s));
  db.close();
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function runScript(extraArgs: string[] = []): { stdout: string; outJsonPath: string } {
  const date = localDate(-1);
  const outJsonPath = join(outDir, `candidates-${date}.json`);
  if (existsSync(outJsonPath)) rmSync(outJsonPath);
  const stdout = execFileSync("node", [scriptPath, "--db", dbPath, "--out", join(outDir, "candidates"), ...extraArgs], { encoding: "utf8" });
  return { stdout, outJsonPath };
}

describe("generate-guard-replay.mjs（F20261008gdcc 项 4）", () => {
  it("默认窗（昨日）：结构化事件提取/去重/窗外过滤/类型过滤全对", () => {
    const { outJsonPath } = runScript();
    expect(existsSync(outJsonPath)).toBe(true);
    const payload = JSON.parse(readFileSync(outJsonPath, "utf8"));
    // s1+s3+s7 入候选；s2 去重、s4 窗外、s5 类型外、s6 被 SQL 口径过滤（§3.3）
    expect(payload.totalIntercepts).toBe(4);
    expect(payload.uniqueSamples).toBe(3);
    const byId = new Map<string, { id: string; ruleId: string; ruleLayer: string; commandHead: string; commandHeadSanitized: string; verdict: string | null }>(
      payload.samples.map((s: { id: string }) => [s.id, s]),
    );
    expect(byId.has("s6")).toBe(false); // 无 ruleId 且无命令前缀 → SQL 排除（非 unknown 候选）
    // 结构化字段透传
    const s1 = byId.get("s1");
    const s3 = byId.get("s3");
    expect(s1).toBeTruthy();
    expect(s1?.ruleId).toBe("main_write");
    expect(s1?.ruleLayer).toBe("r1_gate");
    expect(s1?.commandHead).toBe("cd /repo/wt && git commit -m x");
    // 同命令头异 ruleId 不去重
    expect(s3?.ruleId).toBe("self_kill_literal");
    // 裁决字段就位（裁决是人工职责，脚本只留位）
    expect(s1?.verdict).toBeNull();
    // 脱敏只动引号值段，结构保留
    expect(s1?.commandHeadSanitized).toBe("cd /repo/wt && git commit -m x");
  });

  it("旧格式容错（§3.3 口径后）：无 ruleId 但 description 带命令前缀的真样本仍入候选（json 兼容旧格式）；纯噪声事件被排除", () => {
    const { outJsonPath } = runScript();
    const payload = JSON.parse(readFileSync(outJsonPath, "utf8"));
    // s7：context 有 ruleId 但无 commandHead → 入候选，commandHead 从 description 反查
    const s7 = payload.samples.find((s: { id: string }) => s.id === "s7");
    expect(s7).toBeTruthy();
    expect(s7.ruleId).toBe("data_destructive");
    expect(s7.commandHead).toContain("ls | grep");
    // s6：无 ruleId 且 description 无命令前缀 → SQL 口径排除（bounce 计数事件类噪声）
    const s6 = payload.samples.find((s: { id: string }) => s.id === "s6");
    expect(s6).toBeUndefined();
  });

  it("description 反查：context 缺 commandHead 时从命令前缀段提取", () => {
    const { outJsonPath } = runScript();
    const payload = JSON.parse(readFileSync(outJsonPath, "utf8"));
    const s7 = payload.samples.find((s: { id: string }) => s.id === "s7");
    expect(s7.ruleId).toBe("data_destructive"); // context 透传
    expect(s7.commandHead).toContain("ls | grep");
  });

  it("--date 指定窗：只取该日事件", () => {
    const y2 = localDate(-2);
    const outJsonPath = join(outDir, `candidates-${y2}.json`);
    execFileSync("node", [scriptPath, "--db", dbPath, "--date", y2, "--out", join(outDir, "candidates")], { encoding: "utf8" });
    const payload = JSON.parse(readFileSync(outJsonPath, "utf8"));
    expect(payload.totalIntercepts).toBe(1); // 只有 s4
    expect(payload.samples[0].id).toBe("s4");
  });

  it("db 不存在：退出码 2 + 指引文案", () => {
    let code = 0;
    let stderr = "";
    try {
      execFileSync("node", [scriptPath, "--db", join(tmpDir, "missing.db")], { encoding: "utf8" });
    } catch (e) {
      const err = e as { status?: number; stderr?: string };
      code = err.status ?? 0;
      stderr = err.stderr ?? "";
    }
    expect(code).toBe(2);
    expect(stderr).toContain("db 不存在");
    expect(stderr).toContain("/api/settings");
  });
});
