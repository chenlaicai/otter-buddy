#!/usr/bin/env node
/**
 * 能力文本版本门（F202608xxxxxx）：skill 文件改动必须 bump manifest version。
 *
 * 逻辑：
 * 1. 获取 git staged 文件列表
 * 2. 检查是否有 .pi/skills/ 目录下的改动（含子目录）
 * 3. 如果有，检查 prompts/skills/manifest.yaml 是否也在 staged 中，并且 version 字段有变化
 * 4. 如果 version 没有变化，报错并阻断 commit
 *
 * 退出码：0 通过 / 1 有错误。
 */
import { execSync } from "node:child_process";

const root = process.cwd();

function error(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function getStagedFiles() {
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

function getStagedVersion() {
  try {
    const output = execSync("git show :prompts/skills/manifest.yaml", {
      cwd: root,
      encoding: "utf8",
    });
    return getVersionFromContent(output);
  } catch {
    return null;
  }
}

function getHeadVersion() {
  try {
    const output = execSync("git show HEAD:prompts/skills/manifest.yaml", {
      cwd: root,
      encoding: "utf8",
    });
    return getVersionFromContent(output);
  } catch {
    return null;
  }
}

const stagedFiles = getStagedFiles();

// 检查是否有 .pi/skills/ 目录下的改动
const skillFilesChanged = stagedFiles.some(
  (f) => f.startsWith(".pi/skills/") && f !== ".pi/skills/"
);

if (!skillFilesChanged) {
  // 没有 skill 文件改动，放行
  console.log("[check-skill-version-bump] 无 skill 文件改动，跳过");
  process.exit(0);
}

// 有 skill 文件改动，检查 manifest version 是否 bump
const manifestStaged = stagedFiles.includes("prompts/skills/manifest.yaml");

if (!manifestStaged) {
  error(
    "skill 文件有改动但 prompts/skills/manifest.yaml 未 staged。\n" +
      "请 bump manifest.yaml 中的 version 字段后再提交。"
  );
}

const stagedVersion = getStagedVersion();
const headVersion = getHeadVersion();

if (stagedVersion === null) {
  error("无法读取 prompts/skills/manifest.yaml 的 version 字段");
}

if (headVersion !== null && stagedVersion <= headVersion) {
  error(
    `manifest.yaml version 未 bump（当前: ${stagedVersion}, HEAD: ${headVersion}）。\n` +
      "skill 文件改动必须递增 version 字段。"
  );
}

console.log(
  `[check-skill-version-bump] OK（version: ${headVersion} → ${stagedVersion}）`
);
