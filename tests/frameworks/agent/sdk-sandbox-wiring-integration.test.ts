/** F20261028egitx：穿过真实 SDK 装配的沙箱执行契约，不能只断言 mock 入参。 */
import { describe, expect, it } from "vitest";
import * as sdk from "@earendil-works/pi-coding-agent";
import { createSandboxedAgentSession } from "@frameworks/agent/sandboxed-agent-session";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSandboxedTools } from "@frameworks/agent/bash-sandbox";

const macos = process.platform === "darwin";

describe("AgentSession 沙箱接线", () => {
  it.skipIf(!macos)("baseToolsOverride 穿过公开构造：bash 裹沙箱，write/edit 守卫生效", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "sdk-sandbox-wiring-")));
    // Why: 宿主目录必须独立且在通用 /tmp 写区之外，否则 default allow 会让拒绝断言失真。
    const repo = "/private/etc/otter-sdk-sandbox-readonly";
    const workspace = join(root, "workspace");
    const agentDir = join(root, "agent");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    const dataDir = join(root, "data");
    const guarded = createSandboxedTools(workspace, repo, dataDir);
    expect(guarded.sandboxGuarded).toBe(true);
    const selected = ["read", "write", "edit", "bash"].map(name => guarded.tools[name]!);
    const settingsManager = sdk.SettingsManager.inMemory({ extensions: [] });
    const { session } = await createSandboxedAgentSession(sdk, {
      cwd: workspace,
      sessionManager: sdk.SessionManager.inMemory(),
      settingsManager,
      resourceLoader: new sdk.DefaultResourceLoader({ cwd: workspace, agentDir, settingsManager }),
      tools: selected.map(tool => tool.name),
      baseToolsOverride: guarded.tools,
    });
    try {
      expect(session.getActiveToolNames().sort()).toEqual(["bash", "edit", "read", "write"]);
      const hostTarget = join(repo, "host-must-stay-readonly");
      const bash = session.agent.state.tools.find(tool => tool.name === "bash")!;
      const denied = await bash.execute("bash-deny", { command: `printf escape > ${JSON.stringify(hostTarget)}` });
      expect(denied.details?.exitCode).not.toBe(0);
      expect(existsSync(hostTarget)).toBe(false);

      // 延迟工具激活同样必须保留沙箱覆盖，不能回到 SDK 裸 bash。
      session.setActiveToolsByName([]);
      session.setActiveToolsByName(selected.map(tool => tool.name));
      const hostTargetAfterReactivate = join(repo, "host-after-reactivate");
      const reactivated = session.agent.state.tools.find(tool => tool.name === "bash")!;
      await reactivated.execute("bash-reactivate-deny", { command: `printf escape > ${JSON.stringify(hostTargetAfterReactivate)}` });
      expect(existsSync(hostTargetAfterReactivate)).toBe(false);

      const write = session.agent.state.tools.find(tool => tool.name === "write")!;
      await expect(write.execute("write-deny", { path: hostTarget, content: "escape" }))
        .rejects.toThrow(/file-tool-guard/);
      expect(existsSync(hostTarget)).toBe(false);

      const allowedTarget = join(workspace, "allowed.txt");
      const edit = session.agent.state.tools.find(tool => tool.name === "edit")!;
      writeFileSync(allowedTarget, "before");
      await edit.execute("edit-allow", { path: allowedTarget, edits: [{ oldText: "before", newText: "after" }] });
      expect(existsSync(allowedTarget)).toBe(true);
    } finally {
      session.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
