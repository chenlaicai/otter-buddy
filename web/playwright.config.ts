/**
 * Playwright e2e 配置（F20260920ecig，issue #1058）。
 *
 * - baseURL：环境变量 E2E_BASE_URL 优先（CI 指向 e2e 服务实例），本地默认 alpha 实例端口
 * - spec 内 page.goto 用相对路径（'/memory'），由本配置的 baseURL 解析——单一真相源
 * - 截图经 testInfo.outputPath() 落 playwright outputDir（web/test-results，已 gitignore），
 *   CI 上传 artifact，不再硬编码对话工作区绝对路径
 */
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3116',
    // #1868 阶段 2：登录后会话 cookie 统一进 storageState（global-setup 写入）
    storageState: 'e2e/.auth/owner.json',
  },
  outputDir: './test-results',
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
})
