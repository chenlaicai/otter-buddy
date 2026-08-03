#!/usr/bin/env node
/**
 * bge-m3 模型文件下载脚本（幂等）。
 *
 * - 检查 models/bge-m3/ 下必需文件是否存在且大小匹配；存在则跳过
 * - 缺失文件从 HF_ENDPOINT（默认 https://hf-mirror.com）下载，curl -C - 支持断点续传
 * - 下载失败时打印详细手动下载说明（URL + 目标路径 + 工具建议）后 exit 1
 * - CI 环境自动跳过（CI=true），除非传 --force
 *
 * 用法：
 *   node scripts/download-bge-m3.mjs              # 检查 + 下载（CI 跳过）
 *   node scripts/download-bge-m3.mjs --force      # 强制（CI 也跑）
 *   BGE_M3_DIR=/path node scripts/...             # 自定义模型目录
 *   HF_ENDPOINT=https://hf-mirror.com node ...    # 自定义镜像
 */
import { existsSync, statSync, mkdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODEL_DIR = process.env.BGE_M3_DIR || path.join(process.cwd(), "models", "bge-m3");
const MIRROR = process.env.HF_ENDPOINT || "https://hf-mirror.com";
const REPO = "Xenova/bge-m3";

/** 必需文件清单（单一真相源：bge-m3-files.json，ensure-model.ts 共享同一份。
 * 全部校验 size 防截断。size 来源：hf-mirror.com/Xenova/bge-m3/tree/main 实测字节数。） */
const FILES = JSON.parse(
  readFileSync(path.join(__dirname, "..", "src", "frameworks", "embedding", "bge-m3-files.json"), "utf8"),
);

function fileComplete(relPath, expectedSize) {
  const full = path.join(MODEL_DIR, relPath);
  if (!existsSync(full)) return false;
  if (expectedSize === null) return true;
  try {
    return statSync(full).size === expectedSize;
  } catch {
    return false;
  }
}

function downloadFile(relPath) {
  const url = `${MIRROR}/${REPO}/resolve/main/${relPath}`;
  const dest = path.join(MODEL_DIR, relPath);
  mkdirSync(path.dirname(dest), { recursive: true });
  // -L 跟随重定向（hf-mirror 会 307 到 CDN）
  // -C - 断点续传（已下载部分不重下，大文件恢复关键）
  // --retry 3 失败自动重试
  const result = spawnSync(
    "curl",
    ["-sSL", "-C", "-", "--retry", "3", "--retry-delay", "2", "-o", dest, url],
    { stdio: "inherit" },
  );
  return result.status === 0;
}

function printManualInstructions(missing) {
  console.error("");
  console.error("==========================================================");
  console.error("[bge-m3] 自动下载失败 - 请手动下载以下文件");
  console.error(`目标目录: ${MODEL_DIR}`);
  console.error(`下载源  : ${MIRROR}/${REPO}/resolve/main/<file>`);
  console.error("");
  console.error("缺失文件（保留 onnx/ 子目录结构）:");
  for (const f of missing) {
    console.error(`  ${f.path}`);
  }
  console.error("");
  console.error("建议用支持断点续传的工具（model.onnx_data 有 2.27GB）:");
  console.error(`  curl -C - -L -o "${path.join(MODEL_DIR, "onnx/model.onnx_data")}" \\`);
  console.error(`    ${MIRROR}/${REPO}/resolve/main/onnx/model.onnx_data`);
  console.error("");
  console.error("或换镜像后重试本脚本:");
  console.error("  HF_ENDPOINT=https://hf-mirror.com npm run download:bge-m3");
  console.error("==========================================================");
}

// CI 跳过（CI 不需要真实模型，测试全 mock）
if (process.env.CI && !process.argv.includes("--force")) {
  console.log("[bge-m3] CI 环境检测到，跳过模型下载（CI 不需要真实模型）");
  process.exit(0);
}

const missing = FILES.filter((f) => !fileComplete(f.path, f.size));
if (missing.length === 0) {
  console.log("[bge-m3] 所有模型文件已存在，跳过下载");
  process.exit(0);
}

console.log(`[bge-m3] 缺失 ${missing.length} 个文件，从 ${MIRROR} 下载到 ${MODEL_DIR} ...`);
mkdirSync(MODEL_DIR, { recursive: true });

let allOk = true;
for (const f of missing) {
  console.log(`[bge-m3] 下载 ${f.path} ...`);
  if (!downloadFile(f.path)) {
    console.error(`[bge-m3] 下载失败: ${f.path}`);
    allOk = false;
    break;
  }
}

if (!allOk) {
  printManualInstructions(missing);
  process.exit(1);
}

// 下载后再次校验（防大文件截断）
const stillMissing = FILES.filter((f) => !fileComplete(f.path, f.size));
if (stillMissing.length > 0) {
  console.error("[bge-m3] 下载完成但部分文件大小校验失败（可能截断）:");
  for (const f of stillMissing) {
    console.error(`  ${f.path}`);
  }
  printManualInstructions(stillMissing);
  process.exit(1);
}

console.log("[bge-m3] 所有文件就位");
process.exit(0);
