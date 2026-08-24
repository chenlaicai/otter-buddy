#!/usr/bin/env node
/**
 * 能力文本版本门（F20260824skvg）：skill 文件改动必须 bump manifest version。
 *
 * 逻辑：
 * 1. 获取变更文件列表（pre-commit: staged；CI: branch diff）
 * 2. 检查是否有 .pi/skills/ 目录下的改动（含子目录）
 * 3. 如果有，检查 prompts/skills/manifest.yaml 的 version 字段是否递增
 * 4. 如果 version 没有变化，报错并阻断
 *
 * 退出码：0 通过 / 1 有错误。
 */
import { execSync } from "node:child_process";

const root = process.cwd();
const isCI = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";

function error(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function getChangedFiles() {
  if (isCI) {
    // CI 环境：比较 PR 分支与 main 的差异
    const output = execSync(
      "git diff origin/main...HEAD --name-only --diff-filter=ACMR",
      { cwd: root, encoding: "utf8" }
    );
    return output.split("\n").filter(Boolean);
  }
  // pre-commit 环境：比较 staged 文件
  const output = execSync("git diff --cached --name-only --diff-filter=ACMR", {
    cwd: root,
    encoding: "utf8",
  });
  return output.split("\n").filter(Boolean);
}

function getVersionFromContent(content) {
  const match = content.match(/^version:\s*(\d+)/m);
  return match ? parseInt(match[1], 10) : null;
}

function getManifestVersion(ref) {
  try {
    const output = execSync(`git show ${ref}:prompts/skills/manifest.yaml`, {
      cwd: root,
      encoding: "utf8",
    });
    return getVersionFromContent(output);
  } catch {
    return null;
  }
}

const changedFiles = getChangedFiles();

// 检查是否有 .pi/skills/ 目录下的改动
const skillFilesChanged = changedFiles.some(
  (f) => f.startsWith(".pi/skills/") && f !== ".pi/skills/"
);

if (!skillFilesChanged) {
  // 没有 skill 文件改动，放行
  console.log("[check-skill-version-bump] 无 skill 文件改动，跳过");
  process.exit(0);
}

// 有 skill 文件改动，检查 manifest version 是否 bump
const manifestChanged = changedFiles.includes("prompts/skills/manifest.yaml");

if (!manifestChanged) {
  error(
    "skill 文件有改动但 prompts/skills/manifest.yaml 未变更。\n" +
      "请 bump manifest.yaml 中的 version 字段后再提交。"
  );
}

const currentVersion = isCI ? getManifestVersion("HEAD") : getManifestVersion(":");
const baseVersion = isCI ? getManifestVersion("origin/main") : getManifestVersion("HEAD");

if (currentVersion === null) {
  error("无法读取 prompts/skills/manifest.yaml 的 version 字段");
}

if (baseVersion !== null && currentVersion <= baseVersion) {
  error(
    `manifest.yaml version 未 bump（当前: ${currentVersion}, 基线: ${baseVersion}）。\n` +
      "skill 文件改动必须递增 version 字段。"
  );
}

console.log(
  `[check-skill-version-bump] OK（version: ${baseVersion} → ${currentVersion}）${isCI ? " [CI mode]" : ""}`
);
