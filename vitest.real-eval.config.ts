import { defineConfig } from "vitest/config";
import path from "path";

/** 真实数据库副本的显式评测入口；不进入默认测试套件。 */
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
    include: ["tests/usecases/memory/real-rerank.eval.ts"],
    globals: false,
    passWithNoTests: true,
    maxWorkers: 1,
  },
});
