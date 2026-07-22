import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || undefined,
})
const context = await browser.newContext({
  httpCredentials:
    process.env.ST_USER && process.env.ST_PASS
      ? { username: process.env.ST_USER, password: process.env.ST_PASS }
      : undefined,
  viewport: { width: 1280, height: 900 },
})
const tavern = await context.newPage()
const errors = []
tavern.on('pageerror', (error) => errors.push(`ST: ${error.message}`))

try {
  await tavern.goto(process.env.ST_URL || 'http://127.0.0.1:8000', { waitUntil: 'domcontentloaded' })
  await tavern.locator('#srl-bridge-settings').waitFor({ state: 'attached', timeout: 30_000 })
  await tavern.locator('#srl-bridge-url').evaluate((input, value) => {
    input.value = value
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, process.env.SRL_URL || 'http://127.0.0.1:5173/')
  const popupPromise = tavern.waitForEvent('popup')
  await tavern.locator('#srl-bridge-connect').evaluate((button) => button.click())
  const relay = await popupPromise
  relay.on('pageerror', (error) => errors.push(`中继页: ${error.message}`))
  const srl = relay.frameLocator('#srl-frame')
  await srl.locator('.tavern-bridge-pairing code').waitFor({ timeout: 20_000 })

  const tavernCode = (await tavern.locator('#srl-bridge-code').textContent())?.replace(/\D/g, '')
  const srlCode = (await srl.locator('.tavern-bridge-pairing code').textContent())?.trim()
  if (!tavernCode || tavernCode !== srlCode) throw new Error('两端配对码不一致')

  const accept = srl.getByRole('button', { name: '数字一致，允许本次连接' })
  if (!(await accept.count())) {
    throw new Error(
      `SRL 配对按钮缺失：${await srl.locator('.tavern-bridge-pairing').innerText()}\n酒馆状态：${await tavern.locator('#srl-bridge-status').innerText()}\n中继地址：${relay.url()}`,
    )
  }
  await accept.click()
  await srl.locator('.tavern-bridge__header > span[data-status="connected"]').waitFor({ timeout: 15_000 })
  await tavern
    .locator('#srl-bridge-status[data-status="connected"]')
    .waitFor({ state: 'attached', timeout: 15_000 })
  await srl.locator('.tavern-bridge-groups').waitFor({ timeout: 20_000 })

  const remoteCount = await srl.locator('.tavern-bridge-groups section > button').count()
  if (!remoteCount) throw new Error('酒馆资源目录为空或未返回')
  await srl.locator('.tavern-bridge-groups section > button').first().click()
  await srl.locator('.tavern-bridge__sticky-action').click()
  await srl.locator('.tavern-bridge-report li').first().waitFor({ timeout: 60_000 })
  const pullReport = await srl.locator('.tavern-bridge-report li').first().innerText()
  if (!pullReport.includes('从酒馆接收 1 项')) throw new Error(`拉取资源结果异常：${pullReport}`)
  await relay.setViewportSize({ width: 390, height: 844 })
  const overflow = await srl.locator('html').evaluate(
    (root) => root.scrollWidth > root.clientWidth + 1,
  )
  if (overflow) throw new Error('SRL 酒馆桥接页在 390px 移动端宽度出现横向溢出')
  const relevantErrors = errors.filter((error) => !error.includes("reading 'POPUP_TYPE'"))
  if (relevantErrors.length) throw new Error(relevantErrors.join('\n'))
  console.log(`桥接端到端检查通过：配对成功，读取到 ${remoteCount} 项酒馆资源`)
} finally {
  await context.close()
  await browser.close()
}
