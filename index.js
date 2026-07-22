import { BridgeController } from './modules/BridgeController.js'
import { TavernAdapter } from './modules/TavernAdapter.js'

const SETTINGS_KEY = 'srl-bridge'
const DEFAULT_URL = 'http://127.0.0.1:5173/'
let controller

function context() {
  return window.SillyTavern?.getContext?.()
}

function saveUrl(value) {
  const settings = context().extensionSettings
  settings[SETTINGS_KEY] = { ...(settings[SETTINGS_KEY] ?? {}), srlUrl: value }
  context().saveSettingsDebounced()
}

function setStatus(detail) {
  const status = document.getElementById('srl-bridge-status')
  const code = document.getElementById('srl-bridge-code')
  if (!status || !code) return
  status.dataset.status = detail.status
  status.querySelector('strong').textContent =
    detail.status === 'connected'
      ? '已连接'
      : detail.status === 'pairing'
        ? '等待确认'
        : detail.status === 'waiting'
          ? '正在连接'
          : '尚未连接'
  status.querySelector('small').textContent = detail.detail
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
  input.value = storedUrl || DEFAULT_URL
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
