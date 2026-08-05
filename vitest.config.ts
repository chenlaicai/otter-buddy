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
  },
});
