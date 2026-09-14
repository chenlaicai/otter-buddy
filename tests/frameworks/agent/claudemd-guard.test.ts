/**
 * #496：ResourceLoader 屏蔽 CLAUDE.md / AGENTS.md 祖先目录发现。
 *
 * 背景：SDK loadContextFileFromDir 从 cwd 逐层向上找 CLAUDE.md / AGENTS.md，
 * 注入 buildSystemPrompt 的 <project_context> 段。主仓根的 CLAUDE.md 是给
 * Claude Code 的项目指令，被注入 otter agent 的 system prompt 属无关指令污染。
 * 修复：DefaultResourceLoader 传 noContextFiles: true。
 *
 * 测试用 SDK 原生 DefaultResourceLoader 在临时目录实测（tmp/parent/CLAUDE.md +
 * tmp/parent/child cwd），比单测断言传参更能覆盖 SDK 未来行为变化。
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, getAgentDir } from "@earendil-works/pi-coding-agent";

const __dirname = dirname(fileURLToPath(import.meta.url));

const tmpRoot = mkdtempSync(join(tmpdir(), "otter-claudemd-guard-"));
const parentDir = join(tmpRoot, "parent");
const childDir = join(parentDir, "child");
mkdirSync(childDir, { recursive: true });
writeFileSync(join(parentDir, "CLAUDE.md"), "# CLAUDE.md\n\nClaude Code 专属指令，不应进入 otter agent。\n");

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("ResourceLoader CLAUDE.md 屏蔽（#496）", () => {
  it("noContextFiles: true → 祖先目录 CLAUDE.md 不进入 agentsFiles", async () => {
    const loader = new DefaultResourceLoader({
      cwd: childDir,
      agentDir: getAgentDir(),
      noContextFiles: true,
    });
    await loader.reload();

    const { agentsFiles } = loader.getAgentsFiles();
    expect(agentsFiles.map((f) => f.path)).not.toContain(join(parentDir, "CLAUDE.md"));
  });

  it("对照组：不传 noContextFiles → 祖先目录 CLAUDE.md 被发现（证明 SDK 默认行为即污染源）", async () => {
    const loader = new DefaultResourceLoader({
      cwd: childDir,
      agentDir: getAgentDir(),
    });
    await loader.reload();

    const { agentsFiles } = loader.getAgentsFiles();
    expect(agentsFiles.map((f) => f.path)).toContain(join(parentDir, "CLAUDE.md"));
  });

  it("otter 侧 registry 初始化参数包含 noContextFiles: true（源码锚定）", () => {
    const src = readFileSync(
      join(__dirname, "../../../src/frameworks/agent/model-runtime-registry.ts"),
      "utf-8",
    );
    expect(src).toContain("noContextFiles: true");
  });
});
