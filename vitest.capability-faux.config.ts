import { defineConfig } from "vitest/config";
import path from "node:path";
import fs from "node:fs";

/**
 * 能力测试 faux 档：真系统 + 真 sqlite + faux/录音模型，零外部 LLM 成本。
 * 所有能力文件默认进入硬门禁；文件级排除只能来自 guardrails.json，且 lint
 * 强制其绑定公开 issue。测试内部需要模型智力的场景仍按既有语义显式 skip。
 */
const registry = JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dirname, "tests/capability/guardrails.json"), "utf8"),
) as { capabilities: Array<{ file: string; faux: "run" | "exclude" }> };
const fauxExclusions = registry.capabilities
  .filter(entry => entry.faux === "exclude")
  .map(entry => entry.file);

export default defineConfig({
  resolve: {
    alias: {
      "@entities": path.resolve(import.meta.dirname, "src/entities"),
      "@usecases": path.resolve(import.meta.dirname, "src/usecases"),
      "@interface-adapters": path.resolve(import.meta.dirname, "src/interface-adapters"),
      "@frameworks": path.resolve(import.meta.dirname, "src/frameworks"),
      "@contract": path.resolve(import.meta.dirname, "api-contract"),
    },
  },
  test: {
    include: ["tests/capability/**/*.capability.test.ts"],
    exclude: [...fauxExclusions, "**/node_modules/**"],
    globals: false,
    pool: "forks",
    isolate: true,
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 120_000,
    hookTimeout: 300_000,
    reporters: ["default", "./tests/capability/helpers/skip-reporter.ts"],
  },
});
