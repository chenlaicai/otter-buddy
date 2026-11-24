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
  await expect(onboarding.getByText(/开发态：下载的是 npm CLI tarball/)).toBeVisible()
  const downloadRect = await page.getByTestId('download-connector').boundingBox()
  expect(downloadRect).not.toBeNull()
  expect(downloadRect!.y).toBeGreaterThanOrEqual(0)
  expect(downloadRect!.y + downloadRect!.height).toBeLessThanOrEqual(900)
  await page.screenshot({ path: await evidencePath(testInfo, 'connector-onboarding-entry.png') })

  await page.getByRole('button', { name: '生成配对码' }).click()
  const codeLocator = page.getByTestId('pairing-code')
  await expect(codeLocator).toBeVisible()
  const code = (await codeLocator.textContent())?.trim() ?? ''
  expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/)
  await expect(page.getByTestId('hub-url')).toHaveText(new URL(page.url()).origin)
  await expect(page.getByTestId('pairing-command')).toContainText(`--pair ${code}`)

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
    viewport: { width: 1280, height: 900 },
    downloadRect,
    codeRect,
    dialogRect,
  }, null, 2))
})
