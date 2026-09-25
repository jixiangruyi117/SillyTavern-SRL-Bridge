import { BridgeController } from './modules/BridgeController.js?v=0.3.37'
import { TavernAdapter } from './modules/TavernAdapter.js?v=0.3.37'
import { waitForHostReady } from './modules/HostRuntime.js?v=0.3.37'
import { attachParcelPanel } from './modules/ParcelPanel.js?v=0.3.37'

const SETTINGS_KEY = 'srl-bridge'
let controller

function defaultSrlUrl(hostRuntime) {
  if (hostRuntime?.isTauriTavern) return ''
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
  const devicePanel = document.getElementById('srl-bridge-device-panel')
  const deviceCode = document.getElementById('srl-bridge-device-code')
  const localPairPanel = document.getElementById('srl-bridge-local-pair-panel')
  if (!status || !headerStatus || !code || !devicePanel || !deviceCode || !localPairPanel) return
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
  devicePanel.hidden = !detail.deviceCode || detail.status === 'idle'
  deviceCode.textContent = detail.deviceCode || ''
  document.getElementById('srl-bridge-renew').hidden = !detail.deviceCode || detail.status === 'idle'
  document.getElementById('srl-bridge-disconnect').hidden = detail.status === 'idle'
  if (detail.status === 'connected') localPairPanel.hidden = true
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
  if (document.getElementById('srl-bridge-settings')) return
  const response = await fetch(new URL('./settings.html', import.meta.url))
  const host = document.getElementById('extensions_settings2')
  if (!host || !response.ok) return
  host.insertAdjacentHTML('beforeend', await response.text())
  let hostRuntime
  try {
    const ready = await waitForHostReady()
    hostRuntime = ready.host
  } catch (error) {
    console.error('[SRL Bridge] 酒馆宿主初始化失败', error)
    setStatus({ status: 'idle', detail: `宿主初始化失败：${error instanceof Error ? error.message : '请重新加载扩展'}` })
    for (const button of host.querySelectorAll('#srl-bridge-settings button')) button.disabled = true
    return
  }

  controller = new BridgeController(new TavernAdapter({
    refreshPersonas: async () => {
      const { getUserAvatars } = await import('/scripts/personas.js')
      await getUserAvatars(true)
    },
  }), hostRuntime)
  controller.addEventListener('state', (event) => setStatus(event.detail))
  attachParcelPanel(controller, () => document.getElementById('srl-bridge-url').value.trim())
  controller.addEventListener('log', (event) => appendLog(event.detail))
  controller.addEventListener('local-pair-request', (event) => {
    const panel = document.getElementById('srl-bridge-local-pair-panel')
    if (panel) panel.hidden = !event.detail
  })

  const input = document.getElementById('srl-bridge-url')
  const storedUrl = context().extensionSettings[SETTINGS_KEY]?.srlUrl
  input.value =
    storedUrl &&
    !(isLoopbackUrl(storedUrl) && !['127.0.0.1', 'localhost'].includes(location.hostname))
      ? storedUrl
      : defaultSrlUrl(hostRuntime)
  const addressHint = document.getElementById('srl-bridge-address-hint')
  const updateAddressHint = () => {
    const value = input.value.trim()
    if (hostRuntime.isTauriTavern) {
      const secure = /^https:\/\//i.test(value)
      addressHint.dataset.warning = String(!secure)
      addressHint.textContent = secure
        ? 'TauriTavern 将通过 SRL 的 HTTPS 设备码中继连接，不需要安装酒馆服务端插件。'
        : 'TauriTavern 请填写已部署 /api/bridge 的 HTTPS SRL 地址；iOS 无法使用 Node 服务端插件回退。'
      return
    }
    const isLoopback = isLoopbackUrl(value)
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
      if (hostRuntime.isTauriTavern) {
        void controller.openDevice(value).catch((error) => setStatus({
          status: 'idle',
          detail: error instanceof Error ? error.message : '无法创建设备码',
        }))
        return
      }
      controller.open(value)
    } catch (error) {
      setStatus({
        status: 'idle',
        detail: error instanceof Error ? error.message : '无法打开 SRL',
      })
    }
  })
  document.getElementById('srl-bridge-device').addEventListener('click', async () => {
    try {
      const value = input.value.trim()
      saveUrl(value)
      await controller.openDevice(value)
    } catch (error) {
      setStatus({
        status: 'idle',
        detail: error instanceof Error ? error.message : '无法创建设备码',
      })
    }
  })
  document
    .getElementById('srl-bridge-disconnect')
    .addEventListener('click', () => controller.disconnect())
  document.getElementById('srl-bridge-renew').addEventListener('click', async () => {
    try {
      await controller.openDevice(input.value.trim(), { renew: true })
    } catch (error) {
      setStatus({ status: 'idle', detail: error instanceof Error ? error.message : '无法重新生成设备码' })
    }
  })
  document.getElementById('srl-bridge-copy-code').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(controller.deviceCode)
      appendLog({ at: Date.now(), level: 'success', message: '设备码已复制，请到资源库连接；传输暂停时切回酒馆继续。' })
    } catch {
      appendLog({ at: Date.now(), level: 'warning', message: '无法访问剪贴板，请长按设备码复制。' })
    }
  })
  document.getElementById('srl-bridge-local-pair-approve').addEventListener('click', async () => {
    try {
      await controller.approveLocalAutoPairing()
      document.getElementById('srl-bridge-local-pair-panel').hidden = true
    } catch (error) {
      setStatus({
        status: 'idle',
        detail: error instanceof Error ? error.message : '无法允许本机 APK 连接',
      })
    }
  })

  if (hostRuntime.supportsServerPlugin) {
    try {
      await controller.startLocalAutoPairing()
    } catch (error) {
      appendLog({
        level: 'warning',
        at: Date.now(),
        message: error instanceof Error ? error.message : '本机 APK 自动连接不可用',
      })
    }
  }

  // 浏览器名标签依赖上面注入的 settings.html，必须在注入完成后再写入
  const browserName = currentBrowserName()
  document.getElementById('srl-bridge-browser-name').textContent =
    hostRuntime.isTauriTavern
      ? '复制设备码到资源库连接；iOS 切换应用后可能暂停，请回到前台继续。'
      : `${browserName} · 窗口直连需要同一浏览器；跨浏览器请选择设备码`
  if (hostRuntime.isTauriTavern) {
    document.getElementById('srl-bridge-connection-heading').textContent = 'TauriTavern · HTTPS 连接'
    document.getElementById('srl-bridge-device').hidden = true
    input.placeholder = 'https://你的资源库地址/'
  }
  document.getElementById('srl-bridge-connect-label').textContent = hostRuntime.isTauriTavern
    ? '使用 HTTPS 设备码连接'
    : '在当前浏览器打开并配对'
}

if (document.readyState === 'loading')
  document.addEventListener('DOMContentLoaded', initialize, { once: true })
else void initialize()

window.addEventListener('pagehide', () => controller?.destroy(), {
  once: true,
})
window.addEventListener('beforeunload', () => controller?.destroy(), { once: true })
