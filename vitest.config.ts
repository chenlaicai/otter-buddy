import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@infra": path.resolve(__dirname, "src/infra"),
      "@domain": path.resolve(__dirname, "src/domain"),
      "@app": path.resolve(__dirname, "src/app"),
      "@adapter": path.resolve(__dirname, "src/adapter"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    globals: false,
    passWithNoTests: true,
  },
});
