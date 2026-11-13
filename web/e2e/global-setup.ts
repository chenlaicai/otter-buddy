/**
 * Playwright global-setup（issue #1868 阶段 2）：统一接入登录后写 storageState。
 * 之后所有 spec 以已登录浏览器上下文运行——不再需要硬编码 X-Otter 声明头。
 * token 来源：env E2E_OWNER_TOKEN（缺省 e2e-owner-token，与 scripts/e2e-server.sh 启动注入一致）。
 */
import { chromium } from '@playwright/test'

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3116'
const TOKEN = process.env.E2E_OWNER_TOKEN ?? 'e2e-owner-token'
const STORAGE_STATE = 'e2e/.auth/owner.json'

async function globalSetup(): Promise<void> {
  const browser = await chromium.launch()
  const context = await browser.newContext({ baseURL: BASE_URL })
  const page = await context.newPage()
  await page.goto('/')
  // 会话门未登录会渲染登录屏；直接 POST 登录更快，也验证三端点真实链路
  const res = await page.request.post(`${BASE_URL}/api/auth/login`, {
    data: { token: TOKEN },
  })
  if (!res.ok()) {
    throw new Error(`e2e global-setup login failed: ${res.status()} ${await res.text()}`)
  }
  await context.storageState({ path: STORAGE_STATE })
  await browser.close()
}

export default globalSetup