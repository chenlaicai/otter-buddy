import { defineConfig } from "vitest/config";
import path from "path";

/** F20261112rnkph Phase 1 段 3：标定/反事实评估专用 config——只跑 .eval.ts，不并入 npm test 默认套件。
 *  与 vitest.config.ts 同 alias，但 include 只收 .eval.ts（避免 mergeConfig 数组 concat 把 .test.ts 全量带进来）。 */
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
    include: ["tests/usecases/memory/golden-grid.eval.ts"],
    globals: false,
    passWithNoTests: true,
    maxWorkers: 1,
  },
});