import { defineConfig } from "vitest/config";
import path from "path";

/**
 * 能力测试层（B 类）专用配置：
 * - 真系统（buildApp 全装配）+ 真 embedding（bge-m3）+ 真 LLM（本地配置的端点）
 * - forks 池：每个测试文件独立进程，隔离 config 单例与 pi SDK 模块缓存
 * - 串行：本地只有一个模型端点，且控制 LLM 成本
 * - retry 1：吸收 LLM 非确定性（断言均为行为不变量，非文本精确匹配）
 */
export default defineConfig({
  resolve: {
    alias: {
      "@entities": path.resolve(__dirname, "src/entities"),
      "@usecases": path.resolve(__dirname, "src/usecases"),
      "@interface-adapters": path.resolve(__dirname, "src/interface-adapters"),
      "@frameworks": path.resolve(__dirname, "src/frameworks"),
      "@contract": path.resolve(__dirname, "api-contract"),
    },
  },
  test: {
    include: ["tests/capability/**/*.capability.test.ts"],
    globals: false,
    pool: "forks",
    isolate: true,
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 180_000,
    hookTimeout: 600_000, // bge-m3 加载 + 文档同步（真 embedding 索引全库文档）
    /** 不打 retry：统计采样已内化模型抖动，retry 会与采样叠加掩盖成功率退化（3≥1 × retry1 = 实际 6 采 1） */
    retry: 0,
    reporters: ["default", "./tests/capability/helpers/skip-reporter.ts"],
  },
});
