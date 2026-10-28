#!/usr/bin/env node
/** F20261028egitx：安装漏补丁时 fail-closed，禁止构建/启动出裸沙箱进程。 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const sdkRoot = resolve(process.cwd(), "node_modules/@earendil-works/pi-coding-agent");
const pkg = JSON.parse(readFileSync(resolve(sdkRoot, "package.json"), "utf8"));
const expected = "1.1.0";
const sdk = readFileSync(resolve(sdkRoot, "dist/core/sdk.js"), "utf8");
const declaration = readFileSync(resolve(sdkRoot, "dist/core/sdk.d.ts"), "utf8");
if (pkg.version !== expected || !sdk.includes("baseToolsOverride: options.baseToolsOverride") || !declaration.includes("baseToolsOverride?: Record<string, AgentTool>")) {
  console.error(`[sdk-patch] @earendil-works/pi-coding-agent@${expected} 的 baseToolsOverride 补丁未应用或版本不匹配。`);
  console.error("请执行 npm install（postinstall 会运行 patch-package）；升级 SDK 时必须复核补丁与真实装配测试。");
  process.exit(1);
}
console.log(`[sdk-patch] baseToolsOverride forwarding verified for ${pkg.name}@${pkg.version}`);
