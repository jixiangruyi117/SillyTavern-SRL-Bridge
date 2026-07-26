import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const srlUrl = process.env.SRL_URL || 'http://127.0.0.1:5173/'
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || undefined,
})
const context = await browser.newContext({
  httpCredentials:
    process.env.ST_USER && process.env.ST_PASS
      ? { username: process.env.ST_USER, password: process.env.ST_PASS }
      : undefined,
  viewport: { width: 390, height: 844 },
})

try {
  const login = await context.request.post(new URL('/api/auth/login', srlUrl).href, {
    data: {
      username: process.env.SRL_USER,
      password: process.env.SRL_PASS,
      deviceId: 'codex-bridge-e2e',
      deviceName: 'Codex bridge E2E',
    },
  })
  if (!login.ok()) throw new Error(`SRL login failed: ${login.status()} ${await login.text()}`)
  const session = await login.json()
  if (session.user?.mustChangePassword) {
    const change = await context.request.post(new URL('/api/auth/change-password', srlUrl).href, {
      data: {
        currentPassword: process.env.SRL_PASS,
        newPassword: process.env.SRL_NEW_PASS,
      },
    })
    if (!change.ok()) {
      throw new Error(`SRL password change failed: ${change.status()} ${await change.text()}`)
    }
  }

  const tavern = await context.newPage()
  await tavern.goto(process.env.ST_URL || 'http://127.0.0.1:8000', {
    waitUntil: 'domcontentloaded',
  })
  await tavern
    .locator('#srl-bridge-settings')
    .waitFor({ state: 'attached', timeout: 30_000 })
  await tavern.locator('#srl-bridge-settings .inline-drawer-toggle').evaluate((node) => node.click())
  await tavern.locator('#srl-bridge-url').evaluate((input, value) => {
    input.value = value
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, srlUrl)
  await tavern.locator('#srl-bridge-device').evaluate((node) => node.click())
  const deviceCode = tavern.locator('#srl-bridge-device-code')
  await tavern.waitForFunction(
    () => document.querySelector('#srl-bridge-device-code')?.textContent?.trim().length === 8,
    undefined,
    { timeout: 20_000 },
  )
  const code = ((await deviceCode.textContent()) ?? '').trim()

  const srl = await context.newPage()
  await srl.goto(srlUrl, { waitUntil: 'domcontentloaded' })
  await srl
    .locator('.mobile-bottom-nav > button')
    .nth(1)
    .evaluate((node) => node.click())
  await srl.locator('.feature-app--bridge').click()
  await srl.locator('.tavern-device-join input[type="url"]').fill(
    process.env.ST_URL || 'http://127.0.0.1:8000',
  )
  await srl.locator('.tavern-device-join__code').fill(code)
  const relayPopupPromise = srl.waitForEvent('popup')
  await srl.locator('.tavern-device-join button').click()
  const relay = await relayPopupPromise
  await relay.waitForLoadState('domcontentloaded')
  await srl.locator('.tavern-bridge-pairing code').waitFor({ timeout: 30_000 })
  try {
    await srl.locator('.tavern-bridge-pairing > button').click({ timeout: 20_000 })
  } catch (error) {
    throw new Error(
      `Pairing confirmation is unavailable.\nSRL: ${await srl.locator('body').innerText()}\nRelay: ${await relay.locator('body').innerText()}\n${error}`,
    )
  }
  try {
    await srl
      .locator('.tavern-bridge__header > span[data-status="connected"]')
      .waitFor({ timeout: 20_000 })
  } catch (error) {
    const srlText = await srl.locator('body').innerText().catch(() => '')
    const tavernStatus = await tavern
      .locator('#srl-bridge-status')
      .innerText()
      .catch(() => '')
    throw new Error(
      `Pairing did not connect.\nSRL URL: ${srl.url()}\nSRL: ${srlText}\nST: ${tavernStatus}\n${error}`,
    )
  }
  await srl.locator('.tavern-bridge-groups section > button').first().waitFor({ timeout: 30_000 })

  await srl.locator('.tavern-bridge-groups section > button').first().click()
  await srl.locator('.tavern-bridge__sticky-action').click()
  const report = srl.locator('.tavern-bridge-report li').first()
  await report.waitFor({ timeout: 120_000 })
  const reportText = await report.innerText()
  if (!reportText.includes('从酒馆接收')) {
    throw new Error(`Unexpected transfer report: ${reportText}`)
  }
  console.log(`Bridge transfer E2E passed: ${reportText}`)
} finally {
  await context.close()
  await browser.close()
}
