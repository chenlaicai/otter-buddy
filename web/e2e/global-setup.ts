/**
 * Playwright global-setup：统一接入登录后写 storageState。
 * 之后所有 spec 以已登录浏览器上下文运行——不再需要硬编码 X-Otter 声明头。
 * 口令来源：服务端取 config/config.e2e.yaml 的 auth.ownerPassword（固定 e2e-owner-password）。
 * 这里的 env E2E_OWNER_PASSWORD 只是「测试客户端填什么」的旁路开关，改它必须同步改那份配置。
 */
import { chromium } from '@playwright/test'

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3116'
const PASSWORD = process.env.E2E_OWNER_PASSWORD ?? 'e2e-owner-password'
const STORAGE_STATE = 'e2e/.auth/owner.json'

async function globalSetup(): Promise<void> {
  const browser = await chromium.launch()
  const context = await browser.newContext({ baseURL: BASE_URL })
  const page = await context.newPage()
  await page.goto('/')
  // 会话门未登录会渲染登录屏；直接 POST 登录更快，也验证三端点真实链路
  const res = await page.request.post(`${BASE_URL}/api/auth/login`, {
    data: { password: PASSWORD },
  })
  if (!res.ok()) {
    throw new Error(`e2e global-setup login failed: ${res.status()} ${await res.text()}`)
  }
  await context.storageState({ path: STORAGE_STATE })
  await browser.close()
}

export default globalSetup