import crypto from 'node:crypto'
import fs from 'node:fs'

export const info = {
  id: 'srl-bridge',
  name: 'SRL Device Relay',
  description: 'Short-lived in-memory relay for SRL cross-browser pairing.',
}

const WAITING_TTL = 2 * 60 * 1000
const ACTIVE_TTL = 30 * 60 * 1000
const MAX_MESSAGE_BYTES = 512 * 1024
const MAX_QUEUE_BYTES = 2 * 1024 * 1024
const sessions = new Map()
const attempts = new Map()
let cleanupTimer

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url')
}

function randomCode() {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
  let value = ''
  for (let index = 0; index < 8; index += 1) {
    value += alphabet[crypto.randomInt(0, alphabet.length)]
  }
  return value
}

function randomPairCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
}

function ownerId(request) {
  return String(
    request.user?.profile?.handle ?? request.user?.handle ?? request.session?.userId ?? 'default',
  )
}

function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function sessionRole(session, token) {
  if (safeEqual(session.controllerToken, token)) return 'controller'
  if (safeEqual(session.participantToken, token)) return 'participant'
  return ''
}

function closeWaiter(session, role, payload) {
  const waiter = session.waiters[role]
  if (!waiter) return
  session.waiters[role] = undefined
  clearTimeout(waiter.timer)
  waiter.response.json(payload)
}

function removeSession(code) {
  const session = sessions.get(code)
  if (!session) return
  closeWaiter(session, 'controller', { closed: true, messages: [] })
  closeWaiter(session, 'participant', { closed: true, messages: [] })
  sessions.delete(code)
}

function prune() {
  const now = Date.now()
  for (const [code, session] of sessions) {
    if (session.expiresAt <= now) removeSession(code)
  }
  for (const [key, value] of attempts) {
    if (value.resetAt <= now) attempts.delete(key)
  }
}

function rateLimited(request) {
  const key = request.ip || request.socket?.remoteAddress || 'unknown'
  const now = Date.now()
  const current = attempts.get(key)
  if (!current || current.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + 60_000 })
    return false
  }
  current.count += 1
  return current.count > 12
}

function validHttpUrl(value) {
  try {
    const url = new URL(String(value))
    return ['http:', 'https:'].includes(url.protocol) ? url : undefined
  } catch {
    return undefined
  }
}

function relayHtml(config) {
  const safeConfig = JSON.stringify(config).replace(/</g, '\\u003c')
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="color-scheme" content="light dark">
  <title>SRL 跨浏览器中继</title>
  <style>
    html,body{height:100%;margin:0;background:#111a17;color:#edf1ed;font:15px/1.5 system-ui,sans-serif}
    #status{position:fixed;z-index:2;inset:0 0 auto;padding:.7rem 1rem;background:#183128;border-bottom:1px solid #527567}
    iframe{display:block;width:100%;height:100%;border:0;padding-top:3rem;box-sizing:border-box;background:#f4f0e6}
  </style>
</head>
<body>
  <div id="status">正在通过设备码建立安全通道…</div>
  <iframe id="srl-frame" title="SRL 酒馆资源库"></iframe>
  <script>window.__SRL_RELAY__=${safeConfig}</script>
  <script src="/api/plugins/srl-bridge/relay.js"></script>
</body>
</html>`
}

function queueMessage(session, targetRole, message) {
  const serialized = JSON.stringify(message)
  const bytes = Buffer.byteLength(serialized)
  if (bytes > MAX_MESSAGE_BYTES) throw new Error('单条中继消息超过 512 KiB')
  if (session.queueBytes[targetRole] + bytes > MAX_QUEUE_BYTES) {
    throw new Error('接收端处理过慢，中继队列已满')
  }
  session.queues[targetRole].push({ message, bytes })
  session.queueBytes[targetRole] += bytes
  flush(session, targetRole)
}

function flush(session, role) {
  const waiter = session.waiters[role]
  if (!waiter || !session.queues[role].length) return
  const entries = session.queues[role].splice(0)
  session.queueBytes[role] = 0
  closeWaiter(session, role, {
    messages: entries.map((entry) => entry.message),
  })
}

export async function init(router) {
  const relayScript = fs.readFileSync(new URL('./relay.js', import.meta.url), 'utf8')

  router.post('/sessions', (request, response) => {
    const srlUrl = validHttpUrl(request.body?.srlUrl)
    if (!srlUrl) return response.status(400).json({ error: 'SRL 地址无效' })
    let code
    do code = randomCode()
    while (sessions.has(code))
    const now = Date.now()
    const session = {
      code,
      pairCode: randomPairCode(),
      owner: ownerId(request),
      srlUrl: srlUrl.href,
      srlOrigin: srlUrl.origin,
      controllerToken: randomToken(),
      participantToken: '',
      expiresAt: now + WAITING_TTL,
      queues: { controller: [], participant: [] },
      queueBytes: { controller: 0, participant: 0 },
      waiters: { controller: undefined, participant: undefined },
    }
    sessions.set(code, session)
    return response.json({
      code,
      pairCode: session.pairCode,
      controllerToken: session.controllerToken,
      expiresAt: session.expiresAt,
    })
  })

  router.get('/join', (request, response) => {
    if (rateLimited(request)) return response.status(429).send('尝试过于频繁，请一分钟后重试。')
    const code = String(request.query.code ?? '')
      .trim()
      .toUpperCase()
    const session = sessions.get(code)
    if (!session || session.expiresAt <= Date.now())
      return response.status(404).send('设备码无效或已过期。')
    if (session.owner !== ownerId(request))
      return response.status(403).send('请先登录创建该设备码的酒馆用户。')
    const target = validHttpUrl(request.query.target)
    if (!target || target.origin !== session.srlOrigin)
      return response.status(400).send('SRL 来源与设备码不一致。')
    if (session.participantToken) return response.status(409).send('此设备码已经被使用。')
    session.participantToken = randomToken()
    session.expiresAt = Date.now() + ACTIVE_TTL
    queueMessage(session, 'controller', {
      protocol: 'srl-tavern-bridge',
      version: 2,
      type: 'relay-joined',
    })
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader(
      'Content-Security-Policy',
      `default-src 'self'; frame-src ${session.srlOrigin}; style-src 'unsafe-inline'; script-src 'self' 'unsafe-inline'`,
    )
    return response.type('html').send(
      relayHtml({
        code,
        token: session.participantToken,
        pairCode: session.pairCode,
        srlUrl: target.href,
        srlOrigin: session.srlOrigin,
      }),
    )
  })

  router.get('/relay.js', (_request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    response.type('text/javascript').send(relayScript)
  })

  router.post('/messages', (request, response) => {
    const code = String(request.body?.code ?? '').toUpperCase()
    const session = sessions.get(code)
    const role = sessionRole(session ?? {}, request.body?.token)
    if (!session || !role || session.owner !== ownerId(request)) return response.sendStatus(403)
    if (session.expiresAt <= Date.now()) return response.status(410).json({ error: '设备码已过期' })
    try {
      queueMessage(
        session,
        role === 'controller' ? 'participant' : 'controller',
        request.body?.message,
      )
      session.expiresAt = Date.now() + ACTIVE_TTL
      return response.sendStatus(204)
    } catch (error) {
      return response.status(413).json({
        error: error instanceof Error ? error.message : '中继消息过大',
      })
    }
  })

  router.post('/poll', (request, response) => {
    const code = String(request.body?.code ?? '').toUpperCase()
    const session = sessions.get(code)
    const role = sessionRole(session ?? {}, request.body?.token)
    if (!session || !role || session.owner !== ownerId(request)) return response.sendStatus(403)
    if (session.expiresAt <= Date.now())
      return response.status(410).json({ closed: true, messages: [] })
    if (session.queues[role].length) {
      const entries = session.queues[role].splice(0)
      session.queueBytes[role] = 0
      return response.json({ messages: entries.map((entry) => entry.message) })
    }
    if (session.waiters[role]) closeWaiter(session, role, { messages: [] })
    const timer = setTimeout(() => closeWaiter(session, role, { messages: [] }), 20_000)
    session.waiters[role] = { response, timer }
    const clearDisconnectedWaiter = () => {
      if (session.waiters[role]?.response === response) {
        clearTimeout(timer)
        session.waiters[role] = undefined
      }
    }
    request.on('aborted', clearDisconnectedWaiter)
    response.on('close', () => {
      if (!response.writableEnded) clearDisconnectedWaiter()
    })
  })

  router.post('/close', (request, response) => {
    const code = String(request.body?.code ?? '').toUpperCase()
    const session = sessions.get(code)
    const role = sessionRole(session ?? {}, request.body?.token)
    if (!session || !role || session.owner !== ownerId(request)) return response.sendStatus(403)
    removeSession(code)
    return response.sendStatus(204)
  })

  cleanupTimer = setInterval(prune, 30_000)
  cleanupTimer.unref?.()
  console.log('[SRL Bridge] Short-lived device relay loaded')
}

export async function exit() {
  clearInterval(cleanupTimer)
  for (const code of sessions.keys()) removeSession(code)
}
