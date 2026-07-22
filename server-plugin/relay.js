const config = window.__SRL_RELAY__
const status = document.getElementById('status')
const frame = document.getElementById('srl-frame')
let port
let stopped = false

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

const target = new URL(config.srlUrl)
target.searchParams.set('srlBridge', `relay-${config.code}`)
target.searchParams.set('pair', config.pairCode)
target.searchParams.set('stOrigin', window.location.origin)
frame.src = target.href

window.addEventListener(
  'message',
  (event) => {
    if (event.source !== frame.contentWindow || event.origin !== config.srlOrigin) return
    const message = event.data
    if (message?.protocol !== 'srl-tavern-bridge' || message?.type !== 'srl-hello') return
    const channel = new MessageChannel()
    port = channel.port1
    port.onmessage = (portEvent) => void send(portEvent.data)
    port.start()
    frame.contentWindow.postMessage(
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
    status.textContent = `设备码 ${config.code} · 请核对六位确认码`
    void poll()
  },
  { passive: true },
)

window.addEventListener(
  'pagehide',
  () => {
    stopped = true
    void request('close', { code: config.code, token: config.token }).catch(() => {})
  },
  { once: true },
)
