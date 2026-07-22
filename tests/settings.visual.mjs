import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const output = new URL('../docs/', import.meta.url)
await mkdir(output, { recursive: true })
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || undefined,
})

for (const viewport of [
  { name: 'desktop', width: 1160, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  const context = await browser.newContext({
    httpCredentials:
      process.env.ST_USER && process.env.ST_PASS
        ? { username: process.env.ST_USER, password: process.env.ST_PASS }
        : undefined,
    viewport: { width: viewport.width, height: viewport.height },
  })
  const page = await context.newPage()
  await page.goto(process.env.ST_URL || 'http://127.0.0.1:8000', { waitUntil: 'domcontentloaded' })
  await page.locator('#srl-bridge-settings').waitFor({ state: 'attached', timeout: 30_000 })
  await page
    .locator('#extensions-settings-button .drawer-toggle')
    .evaluate((button) => button.click())
  await page.locator('#rm_extensions_block').waitFor({ state: 'visible' })
  await page.locator('#srl-bridge-settings').scrollIntoViewIfNeeded()
  await page.locator('#srl-bridge-settings .inline-drawer-toggle').click()
  await page.locator('#srl-bridge-settings .inline-drawer-content').waitFor({ state: 'visible' })
  await page.evaluate(() => {
    document.querySelectorAll('#toast-container, .toast-container').forEach((element) => element.remove())
  })
  await page.locator('#srl-bridge-settings').screenshot({
    path: new URL(`settings-${viewport.name}.png`, output).pathname.slice(1),
  })
  await context.close()
}

await browser.close()
console.log('酒馆扩展设置桌面与移动端预览已生成')
