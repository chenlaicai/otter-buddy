/**
 * F20261027gscv Phase 1：write/edit 结构化接防的真实 SDK execute 契约。
 *
 * 不只直接测 policy/helper：每个关键边界都经 createWriteTool/createEditTool 的
 * execute 调用链验证；fixture 全在 fs.mkdtemp 下，不写主仓或生产 data。
 */

import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSandboxedTools } from "@frameworks/agent/bash-sandbox";
import {
  createGuardedEditOperations,
  createGuardedFileTools,
  type FileToolGuardInterceptEvent,
} from "@frameworks/agent/file-tool-guard";
import {
  createFileWritePolicy,
  createFileWritePolicyWithRealpath,
  type FileWritePolicyOptions,
} from "@frameworks/agent/file-write-policy";
import { otterInvokeStorage, type OtterInvokeContext } from "@frameworks/agent/model-runtime-registry";

const platformMock = vi.hoisted(() => vi.fn());
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, platform: platformMock };
});

const nextTurn = promisify(setImmediate);
const actualPlatform = process.platform;

interface Fixture {
  root: string;
  repoRoot: string;
  dataDir: string;
  workspace: string;
  worktree: string;
  options: FileWritePolicyOptions;
}

interface WriteInput {
  path: string;
  content: string;
}

interface EditInput {
  path: string;
  edits: Array<{ oldText: string; newText: string }>;
}

type ContextualExecute = (
  toolCallId: string,
  params: WriteInput | EditInput,
  signal?: AbortSignal,
  onUpdate?: undefined,
  ctx?: { cwd: string },
) => Promise<unknown>;

/** SDK wrapToolDefinition 的 execute 运行时还有第五参 ctx（AgentTool 类型未透出） */
async function execute(tool: AgentTool, params: WriteInput | EditInput, cwd?: string): Promise<unknown> {
  const contextualExecute = tool.execute as unknown as ContextualExecute;
  return contextualExecute("file-tool-guard-test", params, undefined, undefined, cwd ? { cwd } : undefined);
}

async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "file-tool-guard-"));
  const repoRoot = join(root, "repo");
  const dataDir = join(repoRoot, "data");
  const workspace = join(dataDir, "workspaces", "conversation-a");
  const worktree = join(repoRoot, ".otter", "worktrees", "feature-a");
  const alpha = join(root, "alpha");
  const tmp = join(root, "tmp");
  await mkdir(workspace, { recursive: true });
  await mkdir(worktree, { recursive: true });
  await mkdir(join(repoRoot, ".git", "worktrees", "feature-a"), { recursive: true });
  await mkdir(alpha, { recursive: true });
  await mkdir(tmp, { recursive: true });
  return {
    root,
    repoRoot,
    dataDir,
    workspace,
    worktree,
    options: { repoRoot, dataDir, rootsOverride: { alpha, tmp } },
  };
}

function guardedTools(fixture: Fixture): { write: AgentTool; edit: AgentTool } {
  return createGuardedFileTools(fixture.repoRoot, fixture.options);
}

let fixture: Fixture;

beforeEach(async () => {
  platformMock.mockReturnValue(actualPlatform);
  fixture = await makeFixture();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  platformMock.mockReset();
  await rm(fixture.root, { recursive: true, force: true });
});

describe("file-tool-guard（真实 SDK execute）", () => {

  it("write 允许 workspace 新文件并创建不存在的多级父目录", async () => {
    const tools = guardedTools(fixture);
    const target = join(fixture.workspace, "new", "nested", "note.txt");

    await execute(tools.write, { path: target, content: "workspace-ok" });

    expect(await readFile(target, "utf8")).toBe("workspace-ok");
  });

  it("write 主仓新文件在 mkdir 前拒绝，不留下未委托目录", async () => {
    const tools = guardedTools(fixture);
    const parent = join(fixture.repoRoot, "src", "new-parent");
    const target = join(parent, "source.ts");

    await expect(execute(tools.write, { path: target, content: "must-not-write" })).rejects.toThrow(
      /write\.mkdir.*ruleId=file-tool-guard\/main-repo-write/,
    );
    expect(existsSync(parent)).toBe(false);
    expect(existsSync(target)).toBe(false);
  });

  it("write 主仓既有源文件在 writeFile 前拒绝，原内容不变", async () => {
    const tools = guardedTools(fixture);
    const target = join(fixture.repoRoot, "existing.ts");
    await writeFile(target, "original", "utf8");

    await expect(execute(tools.write, { path: target, content: "replacement" })).rejects.toThrow(
      /write\.mkdir.*ruleId=file-tool-guard\/main-repo-write/,
    );
    expect(await readFile(target, "utf8")).toBe("original");
  });

  it("edit 允许 worktree 精确修改", async () => {
    const tools = guardedTools(fixture);
    const target = join(fixture.worktree, "feature.ts");
    await writeFile(target, "const value = 1;\n", "utf8");

    await execute(tools.edit, { path: target, edits: [{ oldText: "value = 1", newText: "value = 2" }] });

    expect(await readFile(target, "utf8")).toBe("const value = 2;\n");
  });

  it("write/edit 均拒绝 worktree .git 指针，ruleId 明确 Git 元数据边界", async () => {
    const tools = guardedTools(fixture);
    const gitPointer = join(fixture.worktree, ".git");
    const pointerContent = `gitdir: ${join(fixture.repoRoot, ".git", "worktrees", "feature-a")}\n`;
    await writeFile(gitPointer, pointerContent, "utf8");

    await expect(execute(tools.write, { path: gitPointer, content: "gitdir: /tmp/redirected\n" })).rejects.toThrow(
      /write\.writeFile.*ruleId=file-tool-guard\/git-metadata-write/,
    );
    await expect(
      execute(tools.edit, { path: gitPointer, edits: [{ oldText: "feature-a", newText: "redirected" }] }),
    ).rejects.toThrow(/edit\.access.*ruleId=file-tool-guard\/git-metadata-write/);
    expect(await readFile(gitPointer, "utf8")).toBe(pointerContent);
  });

  it(".gitignore 与 .github 仍可在 worktree 写入", async () => {
    const tools = guardedTools(fixture);

    await execute(tools.write, { path: join(fixture.worktree, ".gitignore"), content: "dist/\n" });
    await execute(tools.write, { path: join(fixture.worktree, ".github", "ci.yml"), content: "name: ci\n" });

    expect(await readFile(join(fixture.worktree, ".gitignore"), "utf8")).toBe("dist/\n");
    expect(await readFile(join(fixture.worktree, ".github", "ci.yml"), "utf8")).toBe("name: ci\n");
  });

  it("write/edit 均拒绝主仓真实 .git 文件，不因 worktree 白名单放行", async () => {
    const tools = guardedTools(fixture);
    const gitMetadata = join(fixture.repoRoot, ".git", "worktrees", "feature-a", "HEAD");
    await writeFile(gitMetadata, "ref: refs/heads/feature-a\n", "utf8");

    await expect(execute(tools.write, { path: gitMetadata, content: "detached\n" })).rejects.toThrow(
      /write\.mkdir.*ruleId=file-tool-guard\/git-metadata-write/,
    );
    await expect(
      execute(tools.edit, { path: gitMetadata, edits: [{ oldText: "feature-a", newText: "other" }] }),
    ).rejects.toThrow(/edit\.access.*ruleId=file-tool-guard\/git-metadata-write/);
    expect(await readFile(gitMetadata, "utf8")).toBe("ref: refs/heads/feature-a\n");
  });

  it("edit 主仓按写意图拒绝且不改内容；同一 policy 的 readFile 仍可只读主仓", async () => {
    const tools = guardedTools(fixture);
    const target = join(fixture.repoRoot, "read-only-source.ts");
    await writeFile(target, "main repo content", "utf8");

    await expect(
      execute(tools.edit, { path: target, edits: [{ oldText: "main", newText: "changed" }] }),
    ).rejects.toThrow(/edit\.access.*ruleId=file-tool-guard\/main-repo-write/);
    expect(await readFile(target, "utf8")).toBe("main repo content");

    // readFile 是只读透传，不把「可主仓读」误作「禁止读取」；写意图由 access 先拒。
    const operations = createGuardedEditOperations(createFileWritePolicy(fixture.options));
    expect((await operations.readFile(target)).toString("utf8")).toBe("main repo content");
  });

  it("允许区 symlink 指向主仓时按真实落点拒绝，不产生穿透文件", async () => {
    const tools = guardedTools(fixture);
    const link = join(fixture.workspace, "escape-to-repo");
    await symlink(fixture.repoRoot, link, "dir");
    const target = join(link, "escaped.ts");

    await expect(execute(tools.write, { path: target, content: "must-not-escape" })).rejects.toThrow(
      /ruleId=file-tool-guard\/main-repo-write/,
    );
    expect(existsSync(join(fixture.repoRoot, "escaped.ts"))).toBe(false);
  });

  it("write 的 mkdir 已放行后，目标文件 symlink 指向主仓仍在 writeFile 前拒绝", async () => {
    const tools = guardedTools(fixture);
    const mainTarget = join(fixture.repoRoot, "symlink-target.ts");
    const workspaceLink = join(fixture.workspace, "file-link.ts");
    await writeFile(mainTarget, "original-main", "utf8");
    await symlink(mainTarget, workspaceLink, "file");

    await expect(execute(tools.write, { path: workspaceLink, content: "must-not-overwrite" })).rejects.toThrow(
      /write\.writeFile.*ruleId=file-tool-guard\/main-repo-write/,
    );
    expect(await readFile(mainTarget, "utf8")).toBe("original-main");
  });

  it("主仓 symlink 指向允许区时按真实落点放行", async () => {
    const tools = guardedTools(fixture);
    const link = join(fixture.repoRoot, "workspace-alias");
    await symlink(fixture.workspace, link, "dir");

    await execute(tools.write, { path: join(link, "through-alias.txt"), content: "allowed-real-target" });

    expect(await readFile(join(fixture.workspace, "through-alias.txt"), "utf8")).toBe("allowed-real-target");
  });

  it(".. 不会借 workspace 名义写入整个 data；data 其他区域仍拒绝", async () => {
    const tools = guardedTools(fixture);
    const target = join(fixture.dataDir, "local-config.json");

    await expect(
      execute(tools.write, { path: join(fixture.workspace, "..", "..", "local-config.json"), content: "narrow-data" }),
    ).rejects.toThrow(/ruleId=file-tool-guard\/main-repo-write/);
    expect(existsSync(target)).toBe(false);
  });

  it("运行时 ctx.cwd 优先于构造 cwd，判定路径与实际写入路径一致", async () => {
    // 构造 cwd 是主仓，运行时 cwd 是 workspace：相对路径必须真实写入 workspace。
    const tools = guardedTools(fixture);

    await execute(tools.write, { path: "runtime/nested.txt", content: "runtime-cwd" }, fixture.workspace);

    expect(await readFile(join(fixture.workspace, "runtime", "nested.txt"), "utf8")).toBe("runtime-cwd");
    expect(existsSync(join(fixture.repoRoot, "runtime"))).toBe(false);
  });

  it("构造 cwd 是允许区、运行时 ctx.cwd 切到主仓时拒绝", async () => {
    const tools = createGuardedFileTools(fixture.workspace, fixture.options);
    const target = join(fixture.repoRoot, "runtime-denied.txt");

    await expect(execute(tools.write, { path: "runtime-denied.txt", content: "denied" }, fixture.repoRoot)).rejects.toThrow(
      /ruleId=file-tool-guard\/main-repo-write/,
    );
    expect(existsSync(target)).toBe(false);
  });

});

describe("file-write-policy（realpath 失败语义）", () => {
  it("目标 realpath 的 EACCES 不按不存在回退，fail-closed", async () => {
    const { realpathSync } = await import("node:fs");
    const policy = createFileWritePolicyWithRealpath(fixture.options, (path) => {
      if (path.endsWith("denied.txt")) {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      }
      return realpathSync(path);
    });

    expect(policy.checkWriteTarget(join(fixture.workspace, "denied.txt"))).toMatchObject({
      allowed: false,
      ruleId: "file-tool-guard/path-resolve-failed",
    });
  });

  it("allow root realpath 的 EACCES 在构造期失败，不静默建成可放行 policy", async () => {
    const { realpathSync } = await import("node:fs");
    expect(() =>
      createFileWritePolicyWithRealpath(fixture.options, (path) => {
        if (path === join(fixture.dataDir, "workspaces")) {
          throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        }
        return realpathSync(path);
      }),
    ).toThrow(/permission denied/);
  });

  it("realpath 仅对 ENOENT/ENOTDIR 回退，仍允许不存在的新文件", async () => {
    const { realpathSync } = await import("node:fs");
    for (const code of ["ENOENT", "ENOTDIR"]) {
      const policy = createFileWritePolicyWithRealpath(fixture.options, (path) => {
        if (path.endsWith("new-note.txt")) {
          throw Object.assign(new Error("missing"), { code });
        }
        return realpathSync(path);
      });
      expect(policy.checkWriteTarget(join(fixture.workspace, "new-note.txt"))).toMatchObject({
        allowed: true,
        region: "workspaces",
      });
    }
  });

  it("operations 收到非绝对路径时 fail-closed，ruleId 为 path-resolve-failed", async () => {
    const policy = createFileWritePolicy(fixture.options);
    const operations = createGuardedEditOperations(policy);

    await expect(operations.access("relative/source.ts")).rejects.toThrow(
      /ruleId=file-tool-guard\/path-resolve-failed/,
    );
  });

  it("审计事件含 tool/operation/resolvedPath/ruleId/assurance，不含文件内容", async () => {
    const events: FileToolGuardInterceptEvent[] = [];
    const tools = createGuardedFileTools(fixture.repoRoot, {
      ...fixture.options,
      onIntercept: (event) => events.push(event),
    });
    const target = join(fixture.repoRoot, "audited.ts");

    await expect(execute(tools.write, { path: target, content: "secret-file-content" })).rejects.toThrow(
      /ruleId=file-tool-guard\/main-repo-write/,
    );

    expect(events).toEqual([
      {
        tool: "write",
        operation: "mkdir",
        resolvedPath: await realpath(fixture.repoRoot),
        ruleId: "file-tool-guard/main-repo-write",
        assurance: "structured",
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("secret-file-content");
  });

  it("onIntercept 抛错仍保持原拒绝，经 onAuditError 同步报告且无 unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    const auditErrors: Error[] = [];
    try {
      const tools = createGuardedFileTools(fixture.repoRoot, {
        ...fixture.options,
        onIntercept: () => {
          throw new Error("audit-store-unavailable");
        },
        onAuditError: (error) => auditErrors.push(error),
      });

      await expect(
        execute(tools.write, { path: join(fixture.repoRoot, "audit-failure.ts"), content: "denied" }),
      ).rejects.toThrow(/ruleId=file-tool-guard\/main-repo-write/);
      await nextTurn();

      expect(auditErrors.map((error) => error.message)).toEqual(["audit-store-unavailable"]);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("生产 invoke 上下文复用 guardOnIntercept，文件拒绝进入统一 healing 适配器", async () => {
    const calls: Array<{ command: string; reason: string }> = [];
    const store = {
      guardOnIntercept: (input: { command: string; reason: string }) => { calls.push(input); },
    } as OtterInvokeContext;
    vi.stubEnv("TMPDIR", join(fixture.root, "tmp"));
    const { tools } = createSandboxedTools(fixture.workspace, fixture.repoRoot, fixture.dataDir);
    await otterInvokeStorage.run(store, async () => {
      await expect(execute(tools.write, { path: join(fixture.repoRoot, "production-audit.ts"), content: "no-content-log" })).rejects.toThrow(/file-tool-guard/);
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toContain("ruleId=file-tool-guard/main-repo-write");
    expect(calls[0].command).toContain("operation=mkdir");
    expect(calls[0].reason).toContain("[file-tool-guard]");
    expect(calls[0].command).not.toContain("no-content-log");
  });

  it.each([
    { sandboxGuarded: false, platform: "linux" as NodeJS.Platform },
    { sandboxGuarded: true, platform: "darwin" as NodeJS.Platform },
  ])("sg=$sandboxGuarded 时装配出的 write/edit 都经过同一接防（不执行 sandbox-exec）", async ({ sandboxGuarded, platform }) => {
    platformMock.mockReturnValue(platform);
    // 生产默认允许系统 tmp；把本用例的 TMPDIR 收窄到 fixture 的独立 tmp，
    // 否则整个临时主仓都会落入 tmp 白名单，无法验证主仓拒绝。
    vi.stubEnv("TMPDIR", join(fixture.root, "tmp"));
    const { tools, sandboxGuarded: actualGuarded } = createSandboxedTools(
      fixture.workspace,
      fixture.repoRoot,
      fixture.dataDir,
    );
    expect(actualGuarded).toBe(sandboxGuarded);

    await execute(tools.write, { path: "assembled.txt", content: `sg=${sandboxGuarded}` });
    expect(await readFile(join(fixture.workspace, "assembled.txt"), "utf8")).toBe(`sg=${sandboxGuarded}`);

    await expect(
      execute(tools.edit, {
        path: join(fixture.repoRoot, "assembled-main.ts"),
        edits: [{ oldText: "a", newText: "b" }],
      }),
    ).rejects.toThrow(/ruleId=file-tool-guard\/main-repo-write/);
    expect(existsSync(join(fixture.repoRoot, "assembled-main.ts"))).toBe(false);
  });
});
