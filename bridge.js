import { isBridgeEnvelope } from './modules/Protocol.js'

const params = new URLSearchParams(location.search)
const target = params.get('target')
const expectedSrlOrigin = params.get('srlOrigin')
const channel = params.get('channel')
const frame = document.querySelector('#srl-frame')
const state = document.querySelector('#bridge-state')

function fail(message) {
  state.innerHTML = `<strong>无法打开 SRL</strong><small>${message}</small>`
}

let targetUrl
try {
  targetUrl = new URL(target)
  if (!['http:', 'https:'].includes(targetUrl.protocol) || targetUrl.origin !== expectedSrlOrigin) {
    throw new Error('地址校验失败')
  }
  if (!channel || !window.opener) throw new Error('酒馆连接已丢失，请关闭后重试')
  frame.src = targetUrl.href
} catch (error) {
  fail(error instanceof Error ? error.message : '地址无效')
}

frame.addEventListener('load', () => {
  state.setAttribute('data-ready', 'true')
  state.querySelector('strong').textContent = 'SRL 已打开，正在连接酒馆'
  state.querySelector('small').textContent = '请保持本窗口打开；若需要登录，完成后会自动继续配对。'
})

window.addEventListener('message', (event) => {
  const message = event.data
  if (
    event.source === frame.contentWindow &&
    event.origin === expectedSrlOrigin &&
    isBridgeEnvelope(message) &&
    message.type === 'srl-hello' &&
    message.channel === channel
  ) {
    window.opener?.postMessage(
      { ...message, forwardedOrigin: event.origin },
      window.location.origin,
    )
    return
  }

  if (
    event.source === window.opener &&
    event.origin === window.location.origin &&
    isBridgeEnvelope(message) &&
    message.type === 'st-port' &&
    message.channel === channel &&
    event.ports[0]
  ) {
    frame.contentWindow?.postMessage(message, expectedSrlOrigin, [event.ports[0]])
  }
})
