const config = window.__SRL_RELAY__
const status = document.getElementById('status')
const focusButton = document.getElementById('focus-srl')
const host = window.opener
let port
let stopped = false
let invitationTimer
let sendChain = Promise.resolve()

function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

function base64ToBuffer(value) {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes.buffer
}

function encode(value) {
  if (value instanceof ArrayBuffer) return { __srlBuffer: bytesToBase64(value) }
  if (Array.isArray(value)) return value.map(encode)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)]))
  }
  return value
}

function decode(value) {
  if (value && typeof value === 'object' && typeof value.__srlBuffer === 'string') {
    return base64ToBuffer(value.__srlBuffer)
  }
  if (Array.isArray(value)) return value.map(decode)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)]))
  }
  return value
}

async function request(path, body) {
  const csrf = await fetch('/csrf-token', { cache: 'no-store' }).then((response) => response.json())
  const response = await fetch(`/api/plugins/srl-bridge/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf.token },
    body: JSON.stringify(body),
    cache: 'no-store',
  })
  if (!response.ok) throw new Error(`中继请求失败（HTTP ${response.status}）`)
  return response.status === 204 ? undefined : response.json()
}

async function send(message) {
  await request('messages', {
    code: config.code,
    token: config.token,
    message: encode(message),
  })
}

function queueSend(message) {
  sendChain = sendChain
    .then(() => send(message))
    .catch((error) => {
      status.textContent = error instanceof Error ? error.message : '中继发送失败'
      stopped = true
      throw error
    })
  return sendChain
}

async function poll() {
  while (!stopped) {
    try {
      const result = await request('poll', {
        code: config.code,
        token: config.token,
      })
      if (result?.closed) throw new Error('设备码连接已经关闭')
      for (const message of result?.messages ?? []) port?.postMessage(decode(message))
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : '中继连接已断开'
      stopped = true
    }
  }
}

function invitation() {
  if (!host || host.closed) {
    status.textContent = '没有找到原来的资源库页面，请关闭此窗口后重新输入设备码'
    return
  }
  host.postMessage(
    {
      protocol: 'srl-tavern-bridge',
      version: 2,
      type: 'relay-invitation',
      channel: `relay-${config.code}`,
      pairCode: config.pairCode,
    },
    config.srlOrigin,
  )
}

focusButton.addEventListener('click', () => host?.focus())

if (!host) {
  status.textContent = '中继窗口必须由原来的资源库页面打开，请返回后重新连接'
} else {
  invitation()
  invitationTimer = window.setInterval(invitation, 800)
  window.setTimeout(() => {
    if (!port && !stopped) {
      status.textContent =
        '原来的资源库页面没有接收到中继邀请。请回到资源库确认是否出现六位确认码；如果没有，请刷新资源库后重试，或检查浏览器是否阻止弹窗/跨窗口通信。'
    }
  }, 12_000)
}

window.addEventListener(
  'message',
  (event) => {
    if (event.source !== host || event.origin !== config.srlOrigin) return
    const message = event.data
    if (
      message?.protocol !== 'srl-tavern-bridge' ||
      message?.version !== 2 ||
      message?.type !== 'srl-hello' ||
      message?.channel !== `relay-${config.code}`
    ) {
      return
    }
    window.clearInterval(invitationTimer)
    const channel = new MessageChannel()
    port = channel.port1
    port.onmessage = (portEvent) => void queueSend(portEvent.data).catch(() => {})
    port.start()
    host.postMessage(
      {
        protocol: 'srl-tavern-bridge',
        version: 2,
        type: 'st-port',
        channel: `relay-${config.code}`,
        pairCode: config.pairCode,
        capabilities: [
          'character',
          'worldBook',
          'preset',
          'regexGlobal',
          'regexCharacter',
          'regexPreset',
          'quickReply',
          'theme',
        ],
        tavernVersion: '1.18+',
      },
      config.srlOrigin,
      [channel.port2],
    )
    status.textContent = `设备码 ${config.code} · 请回到资源库核对六位确认码`
    void poll()
  },
  { passive: true },
)

window.addEventListener(
  'pagehide',
  () => {
    stopped = true
    window.clearInterval(invitationTimer)
    void request('close', { code: config.code, token: config.token }).catch(() => {})
  },
  { once: true },
)
