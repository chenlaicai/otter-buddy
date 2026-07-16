import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@entities": path.resolve(__dirname, "src/entities"),
      "@usecases": path.resolve(__dirname, "src/usecases"),
      "@interface-adapters": path.resolve(__dirname, "src/interface-adapters"),
      "@frameworks": path.resolve(__dirname, "src/frameworks"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    globals: false,
    passWithNoTests: true,
  },
});
