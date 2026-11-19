#!/usr/bin/env node
/**
 * connector 打包器——packages/connector 出可分发 npm tarball。
 *
 * 职责链：版本一致性校验（packages/connector vs 主仓，防漂移）→ bin 产物可执行位
 * （shebang 文件 npm pack 不自动加 +x，npm i -g 后经 bin 链接执行需要）→
 * npm pack 落 packages/connector/release/（gitignore，产物不入库）。
 *
 * 前置：npm run build:connector 已跑（产物在 packages/connector/dist 且过闭包断言）。
 * 用法：node scripts/package-connector.mjs
 */
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const pkgDir = path.resolve("packages/connector");
const mainJs = path.join(pkgDir, "dist", "connector", "main.js");

const pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
const root = JSON.parse(readFileSync("package.json", "utf8"));
if (pkg.version !== root.version) {
  console.error(`[package-connector] 版本漂移：packages/connector ${pkg.version} ≠ 主仓 ${root.version}——同步后再打包`);
  process.exit(1);
}
if (!existsSync(mainJs)) {
  console.error(`[package-connector] 产物缺失：${mainJs} 不存在——先 npm run build:connector`);
  process.exit(1);
}

chmodSync(mainJs, 0o755);

mkdirSync(path.join(pkgDir, "release"), { recursive: true });

const out = execFileSync(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["pack", "--pack-destination", "release"],
  { cwd: pkgDir, encoding: "utf8" },
).trim();
console.log(`[package-connector] ${path.join(pkgDir, "release", out)}`);
console.log("[package-connector] 设备侧安装：npm i -g <tarball> → otter-connector --hub <url> --pair <code> --name <name>");
