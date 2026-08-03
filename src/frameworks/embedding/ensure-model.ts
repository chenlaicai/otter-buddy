/**
 * 启动时确保 bge-m3 模型文件就位（本地模式）。
 *
 * 若 localModelPath 配置了但文件缺失：调 scripts/download-bge-m3.mjs 重新下载。
 * 下载失败不阻塞启动--worker 加载会失败、走 FTS-only 降级（embedding-service 已处理）。
 */
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { Logger } from "@usecases/ports/logger";
import FILES from "./bge-m3-files.json";

/** 必需文件（单一真相源：bge-m3-files.json，scripts/download-bge-m3.mjs 共享同一份） */
const REQUIRED_FILES = FILES.map((f) => ({ rel: f.path, size: f.size }));

export function isModelPresent(modelDir: string): boolean {
  return REQUIRED_FILES.every((f) => {
    const full = path.join(modelDir, f.rel);
    if (!existsSync(full)) return false;
    try {
      return statSync(full).size === f.size;
    } catch {
      return false;
    }
  });
}

/**
 * 本地模式下检查模型文件；缺失则调下载脚本。
 * 远程模式（localModelPath 未设）直接返回--worker 自行处理远程下载。
 */
export function ensureBgeM3Model(
  config: { localModelPath?: string; modelPath?: string },
  logger: Logger,
): void {
  if (!config.localModelPath) return;

  const modelDir = path.resolve(
    process.cwd(),
    config.localModelPath,
    config.modelPath ?? "bge-m3", // 与 config-service.ts applyDefaults 默认 "Xenova/bge-m3" 不同：
    // 此处是 modelPath 完全未传的兜底（实际 applyDefaults 总会填值）。config.yaml.example
    // 示例用 "bge-m3"（目录名），此处与之对齐。
  );

  if (isModelPresent(modelDir)) {
    logger.info(`Embedding model files present at ${modelDir}`);
    return;
  }

  logger.warn(`Embedding model files missing at ${modelDir}, attempting download...`);
  const scriptPath = path.join(process.cwd(), "scripts", "download-bge-m3.mjs");
  if (!existsSync(scriptPath)) {
    logger.warn(`Download script not found: ${scriptPath}`);
    logger.warn("Worker will fail to load and fall back to FTS-only. Please download model manually.");
    return;
  }

  // 同步等待下载完成（启动时阻塞可接受；正常情况文件已存在，跳过）
  const result = spawnSync("node", [scriptPath], {
    stdio: "inherit",
    env: { ...process.env, BGE_M3_DIR: modelDir },
  });

  if (result.status !== 0 || !isModelPresent(modelDir)) {
    logger.warn("Embedding model download failed or incomplete. See script output above for manual download instructions.");
    logger.warn("Continuing startup - embedding will fall back to FTS-only. Vector search disabled until model is available.");
  } else {
    logger.info("Embedding model downloaded successfully");
  }
}
