import { defineConfig } from "vitest/config";
import path from "path";

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
    include: ["tests/**/*.test.ts"],
    /** 能力测试层（真 LLM/真系统）由 vitest.capability.config.ts 单独跑，本层保持快、CI 安全 */
    exclude: ["tests/capability/**", "**/node_modules/**"],
    globals: false,
    passWithNoTests: true,
    /** 并行负载预算（F20261021plbd，M-d39f3327）：默认 worker 池=CPU 计数×isolate per-file，
     *  把 8 物理核打满（再叠常驻 200% 嵌入 worker 等环境负载），冷启动重的测试被拖过 5s
     *  默认预算随机红（cursor-zero-guard ③ 等，5.3-6.9s 停顿），污染每单 PR 零回归判定。
     *  对照矩阵：默认 3/5 跑红；maxWorkers=4 → 3/3 全绿（受害测试 2.1-2.2s，余量 2.9s）；
     *  maxWorkers=8 → 贴线 4.99s 统计必复发；--no-isolate → vi.mock 失活语义污染 52 红否决。
     *  只收并发不碰断言/超时预算（非测试弱化）。取舍与残余风险见 F20261021plbd。 */
    maxWorkers: 4,
  },
});
