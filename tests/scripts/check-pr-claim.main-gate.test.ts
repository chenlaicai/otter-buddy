/**
 * 认领闸 main() 主流程层回归测试（spawn 真实进程 + stub gh，不碰网络与真实 gh）。
 *
 * 纯函数测试（check-pr-claim.test.ts）覆盖不到 main 层 execFileSync 编排，本文件锚定：
 *   1. closed / PR 引用在触达认领查询前被过滤——stub 中「认领查询一旦被调用即炸」，
 *      任何放行回归立刻变红（#2001 核心修复行为的主流程锚点）；
 *   2. 引用类型/状态查询失败 → exit 2 拒判（fail-closed）——检视 cxref 发现 2 的回归锚点；
 *   3. 真实 OPEN issue 未认领 → exit 1 仍被拦——防过滤语义收得过宽把闸变空转。
 *
 * PR 数据经 --json-file 注入（本就存在的测试通道），stub gh 经 PATH 前置接管
 * `gh api` / `gh issue view` 两种子命令，行为完全确定、零网络依赖。
 */
import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "scripts",
  "check-pr-claim.mjs",
);

let tmpRoot: string | null = null;

/** 建独立沙箱：bin/（stub gh）+ pr.json；stub 体可引用返回的 dir 内其他 fixture 文件。 */
function makeCase(
  ghScript: string | ((dir: string) => string),
  pr: object,
): { binDir: string; prFile: string; dir: string } {
  tmpRoot ??= mkdtempSync(join(tmpdir(), "claim-gate-main-"));
  const dir = mkdtempSync(join(tmpRoot, "case-"));
  const binDir = join(dir, "bin");
  mkdirSync(binDir);
  const body = typeof ghScript === "function" ? ghScript(dir) : ghScript;
  writeFileSync(join(binDir, "gh"), "#!/bin/sh\n" + body, { mode: 0o755 });
  const prFile = join(dir, "pr.json");
  writeFileSync(prFile, JSON.stringify(pr));
  return { binDir, prFile, dir };
}

function runGate(binDir: string, prFile: string) {
  return spawnSync("node", [scriptPath, "--json-file", prFile], {
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
    encoding: "utf8",
  });
}

afterAll(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

describe("check-pr-claim main 层（spawn + stub gh）", () => {
  it("closed PR 引用被过滤：认领查询零触达，exit 0 放行", { timeout: 15000 }, () => {
    const { binDir, prFile, dir } = makeCase(
      (d) =>
        [
          'case "$*" in',
          `  *"api repos/"*) cat "${join(d, "issue-2974.json")}" ;;`,
          '  *) echo "stub: 认领查询不应被调用: $*" >&2; exit 42 ;;',
          "esac",
        ].join("\n"),
      {
        title: "Narrative PR referencing #2974",
        body: "背景见 #2974",
        state: "OPEN",
        headRefName: "feat/narrative-2974",
        files: [{ path: "scripts/foo.mjs" }],
      },
    );
    writeFileSync(
      join(dir, "issue-2974.json"),
      JSON.stringify({ number: 2974, state: "closed", pull_request: { merged_at: null } }),
    );

    const r = runGate(binDir, prFile);
    expect(r.status, `stderr=${r.stderr}`).toBe(0);
    expect(r.stdout).toContain("放行");
  });

  it("引用类型/状态查询失败 → exit 2 拒判（fail-closed）", { timeout: 15000 }, () => {
    const { binDir, prFile } = makeCase(
      [
        'case "$*" in',
        '  *"api repos/"*) echo "gh: boom" >&2; exit 1 ;;',
        "  *) exit 42 ;;",
        "esac",
      ].join("\n"),
      {
        title: "Fix gate for #3000",
        body: "closes #3000",
        state: "OPEN",
        headRefName: "fix/gate-3000",
        files: [{ path: "scripts/foo.mjs" }],
      },
    );

    const r = runGate(binDir, prFile);
    expect(r.status, `stderr=${r.stderr}`).toBe(2);
    expect(r.stderr).toContain("类型/状态查询失败");
  });

  it("真实 OPEN issue 未认领 → exit 1 仍被拦（过滤不过度）", { timeout: 15000 }, () => {
    const { binDir, prFile, dir } = makeCase(
      (d) =>
        [
          'case "$*" in',
          `  *"api repos/"*) cat "${join(d, "issue-3001.json")}" ;;`,
          '  *"issue view"*) echo "[]" ;;',
          "  *) exit 42 ;;",
          "esac",
        ].join("\n"),
      {
        title: "Fix gate for #3001",
        body: "closes #3001",
        state: "OPEN",
        headRefName: "fix/gate-3001",
        files: [{ path: "scripts/foo.mjs" }],
      },
    );
    writeFileSync(join(dir, "issue-3001.json"), JSON.stringify({ number: 3001, state: "open" }));

    const r = runGate(binDir, prFile);
    expect(r.status, `stderr=${r.stderr}`).toBe(1);
    expect(r.stderr).toContain("claim_missing_or_mismatch");
  });
});
