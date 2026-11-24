import { test, expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

async function evidencePath(testInfo: { outputPath: (name: string) => string }, name: string): Promise<string> {
  const target = process.env.CONNECTOR_EVIDENCE_DIR
    ? path.join(process.env.CONNECTOR_EVIDENCE_DIR, name)
    : testInfo.outputPath(name)
  await mkdir(path.dirname(target), { recursive: true })
  return target
}

test('Web 添加设备：登录签发、公开核销、CLI 下载与可见几何证据', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  const created = await page.request.post('/api/conversations', {
    data: { title: `connector onboarding ${Date.now()}` },
  })
  expect(created.ok()).toBe(true)
  const conversation = await created.json() as { id: string }
  await page.goto(`/conversation/${conversation.id}`)
  await page.getByTitle(/执行机与远程动作/).click()

  const onboarding = page.getByTestId('connector-onboarding')
  await expect(onboarding).toBeVisible()
  await expect(onboarding.getByText(/开发态：需要 Node\.js 22\+、npm 和命令行/)).toBeVisible()
  await expect(onboarding.getByText(/开发态未签名：首次打开可能被 macOS 拦截/)).toBeVisible()
  const downloadRect = await page.getByTestId('download-connector').boundingBox()
  expect(downloadRect).not.toBeNull()
  expect(downloadRect!.y).toBeGreaterThanOrEqual(0)
  expect(downloadRect!.y + downloadRect!.height).toBeLessThanOrEqual(900)
  const appDownloadRect = await page.getByTestId('download-connector-app').boundingBox()
  expect(appDownloadRect).not.toBeNull()
  expect(appDownloadRect!.y).toBeGreaterThanOrEqual(0)
  expect(appDownloadRect!.y + appDownloadRect!.height).toBeLessThanOrEqual(900)
  await expect(page.getByTestId('download-bootstrap')).toBeHidden()
  await page.screenshot({ path: await evidencePath(testInfo, 'connector-onboarding-entry.png') })

  await page.getByRole('button', { name: '生成配对码' }).click()
  const codeLocator = page.getByTestId('pairing-code')
  await expect(codeLocator).toBeVisible()
  const code = (await codeLocator.textContent())?.trim() ?? ''
  expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/)
  await expect(page.getByTestId('hub-url')).toHaveText(new URL(page.url()).origin)
  await expect(page.getByTestId('pairing-command')).toContainText(`--pair ${code}`)
  await expect(page.getByRole('button', { name: '生成新码' })).toBeVisible()
  await expect(onboarding.getByText('此前已生成但未核销的码在各自到期前仍可使用；每码只能核销一次。')).toBeVisible()

  // PR-B：可执行安装包下载（登录态；字节/hash/版本头可核）
  const appDownloadEvent = page.waitForEvent('download')
  await page.getByTestId('download-connector-app').click()
  const appDownload = await appDownloadEvent
  expect(appDownload.suggestedFilename()).toMatch(/^otter-connector-.+\.zip$/)
  const appDownloadedPath = await appDownload.path()
  expect(appDownloadedPath).not.toBeNull()
  const appDownloadedBytes = await readFile(appDownloadedPath!)
  expect(appDownloadedBytes.byteLength).toBeGreaterThan(0)
  const appPackageResponse = await page.request.get('/api/connector/download/app')
  expect(appPackageResponse.ok()).toBe(true)
  expect(appPackageResponse.headers()['content-type']).toBe('application/zip')
  const appExpectedHash = appPackageResponse.headers()['x-otter-connector-sha256']
  const appActualHash = createHash('sha256').update(appDownloadedBytes).digest('hex')
  expect(appActualHash).toBe(appExpectedHash)
  expect(appPackageResponse.headers()['x-otter-connector-version']).toBeTruthy()

  // PR-B：引导文件（签发后出现；内嵌活跃码与请求 origin；一次性语义贯穿）
  await expect(page.getByTestId('download-bootstrap')).toBeVisible()
  const bootstrapResponse = await page.request.post('/api/connector/download/bootstrap', {
    data: { code },
  })
  expect(bootstrapResponse.ok()).toBe(true)
  const bootstrap = await bootstrapResponse.json() as { hub: string; code: string; expiresAt: string }
  expect(bootstrap.hub).toBe(new URL(page.url()).origin)
  expect(bootstrap.code).toBe(code)
  expect(new Date(bootstrap.expiresAt).getTime()).toBeGreaterThan(Date.now())

  const redeemed = await page.request.post('/api/connector/pair', {
    data: { code, name: 'Playwright 验收设备' },
  })
  expect(redeemed.status()).toBe(201)
  const device = await redeemed.json() as { deviceId: string }
  const replayed = await page.request.post('/api/connector/pair', {
    data: { code, name: 'Playwright 重放设备' },
  })
  expect(replayed.status()).toBe(403)
  await page.getByTitle('刷新', { exact: true }).click()
  await expect(page.getByTestId(`machine-option-${device.deviceId}`)).toContainText('离线')

  const downloadEvent = page.waitForEvent('download')
  await page.getByTestId('download-connector').click()
  const download = await downloadEvent
  expect(download.suggestedFilename()).toMatch(/^otter-buddy-connector-.+\.tgz$/)
  const downloadedPath = await download.path()
  expect(downloadedPath).not.toBeNull()
  const downloadedBytes = await readFile(downloadedPath!)
  expect(downloadedBytes.byteLength).toBeGreaterThan(0)
  const packageResponse = await page.request.get('/api/connector/download')
  expect(packageResponse.ok()).toBe(true)
  const expectedHash = packageResponse.headers()['x-otter-connector-sha256']
  const actualHash = createHash('sha256').update(downloadedBytes).digest('hex')
  expect(actualHash).toBe(expectedHash)
  expect(packageResponse.headers()['x-otter-connector-version']).toBeTruthy()

  await page.getByTestId('pairing-details').scrollIntoViewIfNeeded()
  const codeRect = await codeLocator.boundingBox()
  const dialogRect = await page.getByRole('dialog').boundingBox()
  expect(codeRect).not.toBeNull()
  expect(dialogRect).not.toBeNull()
  expect(codeRect!.x).toBeGreaterThanOrEqual(dialogRect!.x)
  expect(codeRect!.x + codeRect!.width).toBeLessThanOrEqual(dialogRect!.x + dialogRect!.width)
  expect(codeRect!.y).toBeGreaterThanOrEqual(0)
  expect(codeRect!.y + codeRect!.height).toBeLessThanOrEqual(900)
  await page.screenshot({ path: await evidencePath(testInfo, 'connector-onboarding-issued.png') })

  const metadataPath = await evidencePath(testInfo, 'connector-onboarding-evidence.json')
  await writeFile(metadataPath, JSON.stringify({
    origin: new URL(page.url()).origin,
    redeemedDeviceId: device.deviceId,
    replayRejected: true,
    downloadedFileName: download.suggestedFilename(),
    connectorVersion: packageResponse.headers()['x-otter-connector-version'],
    sha256: actualHash,
    appDownloadedFileName: appDownload.suggestedFilename(),
    appSha256: appActualHash,
    appVersion: appPackageResponse.headers()['x-otter-connector-version'],
    bootstrapHub: bootstrap.hub,
    viewport: { width: 1280, height: 900 },
    downloadRect,
    appDownloadRect,
    codeRect,
    dialogRect,
  }, null, 2))
})
