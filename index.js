import { BridgeController } from './modules/BridgeController.js'
import { TavernAdapter } from './modules/TavernAdapter.js'

const SETTINGS_KEY = 'srl-bridge'
let controller

function defaultSrlUrl() {
  const host = window.location.hostname || '127.0.0.1'
  return `http://${host}:5173/`
}

function isLoopbackUrl(value) {
  return /^(https?:\/\/)?(127\.0\.0\.1|localhost)(:\d+)?\/?/i.test(value)
}

function context() {
  return window.SillyTavern?.getContext?.()
}

function currentBrowserName() {
  const brands = navigator.userAgentData?.brands ?? []
  const names = brands.map((brand) => brand.brand)
  if (names.some((name) => /Edge/i.test(name))) return 'Microsoft Edge'
  if (names.some((name) => /Opera/i.test(name))) return 'Opera'
  if (names.some((name) => /Chrome|Chromium/i.test(name))) return 'Google Chrome / Chromium'
  const agent = navigator.userAgent
  if (/Firefox\//i.test(agent)) return 'Mozilla Firefox'
  if (/Edg\//i.test(agent)) return 'Microsoft Edge'
  if (/OPR\//i.test(agent)) return 'Opera'
  if (/Chrome\//i.test(agent)) return 'Google Chrome'
  if (/Safari\//i.test(agent)) return 'Safari'
  return '当前酒馆浏览器'
}

function saveUrl(value) {
  const settings = context().extensionSettings
  settings[SETTINGS_KEY] = { ...(settings[SETTINGS_KEY] ?? {}), srlUrl: value }
  context().saveSettingsDebounced()
}

function setStatus(detail) {
  const status = document.getElementById('srl-bridge-status')
  const headerStatus = document.getElementById('srl-bridge-header-status')
  const code = document.getElementById('srl-bridge-code')
  if (!status || !headerStatus || !code) return
  status.dataset.status = detail.status
  headerStatus.dataset.status = detail.status
  const label =
    detail.status === 'connected'
      ? '已连接'
      : detail.status === 'pairing'
        ? '等待确认'
        : detail.status === 'waiting'
          ? '正在连接'
          : '尚未连接'
  status.querySelector('strong').textContent = label
  status.querySelector('em').textContent = detail.detail
  headerStatus.querySelector('span').textContent = label === '尚未连接' ? '未连接' : label
  code.hidden = !detail.pairCode || detail.status === 'idle'
  code.textContent = detail.pairCode ? `配对码 ${detail.pairCode}` : ''
}

function appendLog(detail) {
  const list = document.getElementById('srl-bridge-log')
  if (!list) return
  const item = document.createElement('li')
  item.dataset.level = detail.level
  item.textContent = `${new Date(detail.at).toLocaleTimeString()} · ${detail.message}`
  list.prepend(item)
  while (list.children.length > 5) list.lastElementChild?.remove()
}

async function initialize() {
  if (!context()) return
  const response = await fetch(new URL('./settings.html', import.meta.url))
  const host = document.getElementById('extensions_settings2')
  if (!host || !response.ok) return
  host.insertAdjacentHTML('beforeend', await response.text())

  controller = new BridgeController(new TavernAdapter())
  controller.addEventListener('state', (event) => setStatus(event.detail))
  controller.addEventListener('log', (event) => appendLog(event.detail))

  const input = document.getElementById('srl-bridge-url')
  const storedUrl = context().extensionSettings[SETTINGS_KEY]?.srlUrl
  input.value =
    storedUrl && !(isLoopbackUrl(storedUrl) && !['127.0.0.1', 'localhost'].includes(location.hostname))
      ? storedUrl
      : defaultSrlUrl()
  const addressHint = document.getElementById('srl-bridge-address-hint')
  const updateAddressHint = () => {
    const isLoopback = isLoopbackUrl(input.value.trim())
    addressHint.dataset.warning = String(isLoopback)
    addressHint.textContent = isLoopback
      ? '当前地址只适合这台设备。手机端请改用电脑局域网 IP（例如 192.168.x.x）或已部署的 HTTPS 地址。'
      : '手机和电脑都需要能够访问这个地址；使用 HTTPS 部署时，酒馆与 SRL 建议保持相同协议。'
  }
  updateAddressHint()
  input.addEventListener('input', updateAddressHint)
  input.addEventListener('change', () => saveUrl(input.value.trim()))
  document.getElementById('srl-bridge-connect').addEventListener('click', () => {
    try {
      const value = input.value.trim()
      saveUrl(value)
      controller.open(value)
    } catch (error) {
      setStatus({ status: 'idle', detail: error instanceof Error ? error.message : '无法打开 SRL' })
    }
  })
  document.getElementById('srl-bridge-disconnect').addEventListener('click', () => controller.disconnect())
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true })
else void initialize()

window.addEventListener('pagehide', () => controller?.destroy(), { once: true })
  const browserName = currentBrowserName()
  document.getElementById('srl-bridge-browser-name').textContent =
    `${browserName} · 酒馆与 SRL 必须位于同一浏览器配置中`
  document.getElementById('srl-bridge-connect-label').textContent =
    `在 ${browserName} 打开并配对`
