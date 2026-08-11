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
  if (payload.kind === 'frontendStatus') {
    const html = text(payload.html)
    if (!html) throw new Error('临时预览没有可显示的状态栏内容')
    return {
      kind: 'frontendStatus',
      title: text(payload.title, 160) || '前端了么状态栏',
      html,
      css: text(payload.css),
    }
  }
  throw new Error('临时预览类型不受支持')
}

function removeExistingPreview() {
  document.getElementById('srl-live-preview-message')?.remove()
}

function appendPreviewChrome(message, title) {
  const chrome = document.createElement('style')
  chrome.textContent = `
    #srl-live-preview-message { position: relative; }
    #srl-live-preview-message .srl-live-preview__toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: .4em .7em; margin-bottom: .65em; opacity: .82; font-size: .9em; }
    #srl-live-preview-message .srl-live-preview__title { font-weight: 700; }
    #srl-live-preview-message .srl-live-preview__note { flex: 1 1 15em; }
    #srl-live-preview-message .srl-live-preview__close { min-height: 2.2em; padding: .2em .55em; }
    #srl-live-preview-message .srl-live-preview__pager { display: flex; gap: .55em; margin-top: .8em; }
    #srl-live-preview-message .srl-live-preview__pager button { min-height: 2.5em; }
  `
  const toolbar = document.createElement('div')
  toolbar.className = 'srl-live-preview__toolbar'
  const label = document.createElement('strong')
  label.className = 'srl-live-preview__title'
  label.textContent = `SRL 临时预览 · ${title}`
  const note = document.createElement('small')
  note.className = 'srl-live-preview__note'
  note.textContent = '仅当前页面显示，不写入聊天、预设或资源'
  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'srl-live-preview__close'
  close.textContent = '关闭预览'
  close.addEventListener('click', removeExistingPreview)
  toolbar.append(label, note, close)
  message.append(chrome, toolbar)
}

function createPreviewMessage(title) {
  const chat = document.getElementById('chat')
  if (!chat) throw new Error('当前酒馆没有可用的聊天区，无法显示临时预览')
  removeExistingPreview()
  const message = document.createElement('div')
  message.id = 'srl-live-preview-message'
  message.className = 'mes srl-live-preview-message'
  message.dataset.srlTemporaryPreview = 'true'
  const body = document.createElement('div')
  body.className = 'mes_text'
  appendPreviewChrome(message, title)
  message.append(body)
  message.addEventListener('click', (event) => {
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null
    if (link && /^javascript:/iu.test(link.getAttribute('href') || '')) event.preventDefault()
  })
  chat.append(message)
  message.scrollIntoView({ behavior: 'smooth', block: 'center' })
  return { message, body }
}

function cleanPreviewNodes(target) {
  target.querySelectorAll('script, iframe, object, embed, form').forEach((node) => node.remove())
  target.querySelectorAll('*').forEach((node) => {
    for (const attribute of Array.from(node.attributes)) {
      if (/^on/iu.test(attribute.name) || /^javascript:/iu.test(attribute.value)) {
        node.removeAttribute(attribute.name)
      }
    }
  })
}

function insertFormattedMessage(context, target, source, characterName) {
  if (typeof context.messageFormatting !== 'function') {
    throw new Error('当前酒馆未公开 messageFormatting，无法保证真实渲染')
  }
  const formatted = context.messageFormatting(source, characterName, false, false, 0)
  if (typeof formatted !== 'string') throw new Error('酒馆未返回可用的真实格式化结果')
  target.innerHTML = formatted
  cleanPreviewNodes(target)
}

function insertStatusMarkup(target, html) {
  target.innerHTML = html
  cleanPreviewNodes(target)
}

function appendScopedStyle(message, css) {
  if (!css) return
  const style = document.createElement('style')
  style.textContent = css
  message.append(style)
}

export async function showLivePreview(context, file) {
  const payload = parseLivePreviewPayload(await file.text())
  const { message, body } = createPreviewMessage(payload.title)
  if (payload.kind === 'beautification') {
    appendScopedStyle(message, payload.css)
    insertFormattedMessage(context, body, '这是由 SRL 发起的临时主题预览。', 'SRL')
    return { status: 'previewed', name: payload.title }
  }
  if (payload.kind === 'frontendStatus') {
    appendScopedStyle(message, payload.css)
    insertStatusMarkup(body, payload.html)
    return { status: 'previewed', name: payload.title }
  }
  const pager = document.createElement('div')
  pager.className = 'srl-live-preview__pager'
  const previous = document.createElement('button')
  const next = document.createElement('button')
  previous.type = next.type = 'button'
  previous.textContent = '上一条'
  next.textContent = '下一条'
  let index = 0
  const render = () => insertFormattedMessage(context, body, payload.greetings[index], payload.characterName)
  previous.addEventListener('click', () => {
    index = (index + payload.greetings.length - 1) % payload.greetings.length
    render()
  })
  next.addEventListener('click', () => {
    index = (index + 1) % payload.greetings.length
    render()
  })
  render()
  pager.append(previous, next)
  message.append(pager)
  return { status: 'previewed', name: payload.title }
}
