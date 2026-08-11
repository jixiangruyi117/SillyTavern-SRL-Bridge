const FORMAT = 'srl-live-tavern-preview'
const MAX_GREETINGS = 32
const MAX_TEXT_LENGTH = 200_000

function text(value, limit = MAX_TEXT_LENGTH) {
  return typeof value === 'string' && value.length <= limit ? value : ''
}

export function parseLivePreviewPayload(source) {
  let payload
  try {
    payload = JSON.parse(source)
  } catch {
    throw new Error('临时预览数据不是有效 JSON')
  }
  if (!payload || typeof payload !== 'object' || payload.format !== FORMAT || payload.version !== 1) {
    throw new Error('临时预览数据版本不受支持')
  }
  if (payload.kind === 'characterGreeting') {
    const greetings = Array.isArray(payload.greetings)
      ? payload.greetings.map((item) => text(item)).filter(Boolean).slice(0, MAX_GREETINGS)
      : []
    if (!greetings.length) throw new Error('临时预览没有可显示的开场白')
    return {
      kind: 'characterGreeting',
      title: text(payload.title, 160) || '角色开场白',
      characterName: text(payload.characterName, 160) || '角色',
      greetings,
    }
  }
  if (payload.kind === 'beautification') {
    const css = text(payload.css)
    if (!css) throw new Error('临时预览没有可显示的 CSS')
    return { kind: 'beautification', title: text(payload.title, 160) || '主题美化', css }
  }
  throw new Error('临时预览类型不受支持')
}

function removeExistingPreview() {
  document.getElementById('srl-live-preview-host')?.remove()
}

function createHost(title) {
  removeExistingPreview()
  const host = document.createElement('section')
  host.id = 'srl-live-preview-host'
  host.setAttribute('role', 'dialog')
  host.setAttribute('aria-modal', 'true')
  host.setAttribute('aria-label', 'SRL 临时酒馆预览')
  host.innerHTML = `<style>
    #srl-live-preview-host { position: fixed; inset: 0; z-index: 2147483000; display: grid; place-items: center; padding: 18px; background: rgba(0,0,0,.58); }
    #srl-live-preview-shell { width: min(760px, 100%); max-height: min(82vh, 900px); overflow: auto; border-radius: 12px; background: var(--SmartThemeBlurTintColor, #222); color: var(--SmartThemeBodyColor, #eee); box-shadow: 0 20px 70px #000; }
    #srl-live-preview-toolbar { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-bottom: 1px solid color-mix(in srgb, currentColor 20%, transparent); }
    #srl-live-preview-toolbar strong { flex: 1; } #srl-live-preview-toolbar button { min-height: 38px; }
    #srl-live-preview-stage { min-height: 120px; padding: 14px; } #srl-live-preview-stage #chat { margin: 0; }
    #srl-live-preview-note { margin: 0; padding: 0 14px 14px; opacity: .75; font-size: .9em; }
  </style><div id="srl-live-preview-shell"><header id="srl-live-preview-toolbar"><strong></strong><button type="button" data-srl-preview-close>关闭</button></header><main id="srl-live-preview-stage"><div id="chat"></div></main><p id="srl-live-preview-note">真实酒馆格式化 · 临时显示 · 不写入聊天、预设或资源</p></div>`
  host.querySelector('strong').textContent = title
  host.querySelector('[data-srl-preview-close]').addEventListener('click', removeExistingPreview)
  host.addEventListener('click', (event) => {
    if (event.target === host) removeExistingPreview()
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null
    if (link && /^javascript:/iu.test(link.getAttribute('href') || '')) event.preventDefault()
  })
  document.body.append(host)
  return host
}

function insertFormattedMessage(context, target, source, characterName) {
  if (typeof context.messageFormatting !== 'function') {
    throw new Error('当前酒馆未公开 messageFormatting，无法保证真实渲染')
  }
  const formatted = context.messageFormatting(source, characterName, false, false, 0)
  if (typeof formatted !== 'string') throw new Error('酒馆未返回可用的真实格式化结果')
  target.innerHTML = formatted
  target.querySelectorAll('script, iframe, object, embed').forEach((node) => node.remove())
  target.querySelectorAll('*').forEach((node) => {
    for (const attribute of Array.from(node.attributes)) {
      if (/^on/iu.test(attribute.name) || /^javascript:/iu.test(attribute.value)) node.removeAttribute(attribute.name)
    }
  })
}

export async function showLivePreview(context, file) {
  const payload = parseLivePreviewPayload(await file.text())
  const host = createHost(payload.title)
  const chat = host.querySelector('#chat')
  if (!chat) throw new Error('临时预览容器创建失败')
  if (payload.kind === 'beautification') {
    const style = document.createElement('style')
    style.textContent = payload.css
    host.append(style)
    const message = document.createElement('div')
    message.className = 'mes'
    const body = document.createElement('div')
    body.className = 'mes_text'
    insertFormattedMessage(context, body, '这是由 SRL 发起的临时主题预览。', 'SRL')
    message.append(body)
    chat.append(message)
    return { status: 'previewed', name: payload.title }
  }
  const message = document.createElement('div')
  message.className = 'mes'
  const body = document.createElement('div')
  body.className = 'mes_text'
  const previous = document.createElement('button')
  const next = document.createElement('button')
  previous.type = next.type = 'button'
  previous.textContent = '上一条'
  next.textContent = '下一条'
  let index = 0
  const render = () => insertFormattedMessage(context, body, payload.greetings[index], payload.characterName)
  previous.addEventListener('click', () => { index = (index + payload.greetings.length - 1) % payload.greetings.length; render() })
  next.addEventListener('click', () => { index = (index + 1) % payload.greetings.length; render() })
  render()
  message.append(body, previous, next)
  chat.append(message)
  return { status: 'previewed', name: payload.title }
}
