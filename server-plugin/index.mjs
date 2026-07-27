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

function refreshActiveSession(session, role) {
  if (!session.participantToken) return
  const now = Date.now()
  session.lastSeen[role] = now
  const oldestSeen = Math.min(session.lastSeen.controller || now, session.lastSeen.participant || now)
  session.expiresAt = oldestSeen + ACTIVE_TTL
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

function setRelayCors(request, response, session) {
  const origin = request.headers?.origin
  if (!origin || origin !== session?.srlOrigin) return
  response.setHeader('Access-Control-Allow-Origin', origin)
  response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  response.setHeader('Access-Control-Max-Age', '600')
  response.setHeader('Vary', 'Origin')
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
    *{box-sizing:border-box}
    html,body{min-height:100%;margin:0;background:#101b17;color:#edf1ed;font:15px/1.6 system-ui,sans-serif}
    body{display:grid;min-height:100dvh;place-items:center;padding:24px}
    main{width:min(100%,420px);padding:28px;border:1px solid #557b6d;background:#15251f;box-shadow:0 24px 70px #0007}
    small{display:block;color:#9fc9b9;font-size:11px;font-weight:700;letter-spacing:.16em}
    h1{margin:.4rem 0 1rem;font:500 28px/1.15 Georgia,serif}
    #status{min-height:72px;padding:14px;border-left:3px solid #91c7b2;background:#0c1713}
    p{margin:1rem 0;color:#b9c9c2}
    button{width:100%;min-height:48px;border:1px solid #91c7b2;color:#102019;background:#b7dece;font-weight:700;cursor:pointer}
  </style>
</head>
<body>
  <main>
    <small>SRL DEVICE RELAY</small>
    <h1>酒馆连接中继</h1>
    <div id="status">正在把连接交给原来的资源库页面…</div>
    <p>请保留此窗口。资源和操作仍在原来的 HTTPS 资源库中，不会在这里创建另一份本地数据。</p>
    <button id="focus-srl" type="button">返回原来的资源库</button>
  </main>
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
      srlUrl: srlUrl.href,
      srlOrigin: srlUrl.origin,
      controllerToken: randomToken(),
      participantToken: '',
      expiresAt: now + WAITING_TTL,
      lastSeen: { controller: now, participant: 0 },
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

  const joinRelay = (request, response) => {
    if (rateLimited(request)) return response.status(429).send('尝试过于频繁，请一分钟后重试。')
    const code = String(request.query.code ?? '')
      .trim()
      .toUpperCase()
    const session = sessions.get(code)
    if (!session || session.expiresAt <= Date.now())
      return response.status(404).send('设备码无效或已过期。')
    if (session.participantToken) return response.status(409).send('此设备码已经被使用。')
    session.participantToken = randomToken()
    session.lastSeen.controller = Date.now()
    session.lastSeen.participant = Date.now()
    session.expiresAt = Date.now() + ACTIVE_TTL
    queueMessage(session, 'controller', {
      protocol: 'srl-tavern-bridge',
      version: 2,
      type: 'relay-joined',
    })
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Cross-Origin-Opener-Policy', 'unsafe-none')
    response.setHeader(
      'Content-Security-Policy',
      `default-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'self' 'unsafe-inline'`,
    )
    return response.type('html').send(
      relayHtml({
        code,
        token: session.participantToken,
        pairCode: session.pairCode,
        // 设备码创建时已经锁定可信 SRL 地址。加入端只提交短时设备码，
        // 不再用可能经过重定向或不同入口的当前页面地址重复判定来源。
        srlUrl: session.srlUrl,
        srlOrigin: session.srlOrigin,
        relayBase: '/api/plugins/srl-bridge/',
      }),
    )
  }

  router.get('/join-v2', joinRelay)

  router.get('/relay.js', (_request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    response.type('text/javascript').send(relayScript)
  })

  if (typeof router.options === 'function') {
    const preflight = (_request, response) => {
      response.setHeader('Access-Control-Allow-Origin', '*')
      response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type')
      response.setHeader('Access-Control-Max-Age', '600')
      return response.sendStatus(204)
    }
    router.options('/messages', preflight)
    router.options('/poll', preflight)
    router.options('/close', preflight)
  }

  router.post('/messages', (request, response) => {
    const code = String(request.body?.code ?? '').toUpperCase()
    const session = sessions.get(code)
    const role = sessionRole(session ?? {}, request.body?.token)
    if (!session || !role) return response.sendStatus(403)
    setRelayCors(request, response, session)
    if (session.expiresAt <= Date.now()) return response.status(410).json({ error: '设备码已过期' })
    try {
      queueMessage(
        session,
        role === 'controller' ? 'participant' : 'controller',
        request.body?.message,
      )
      refreshActiveSession(session, role)
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
    if (!session || !role) return response.sendStatus(403)
    setRelayCors(request, response, session)
    if (session.expiresAt <= Date.now())
      return response.status(410).json({ closed: true, messages: [] })
    refreshActiveSession(session, role)
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
    if (!session || !role) return response.sendStatus(403)
    setRelayCors(request, response, session)
    removeSession(code)
    return response.sendStatus(204)
  })

  cleanupTimer = setInterval(prune, 30_000)
  cleanupTimer.unref?.()
  console.log('[SRL Bridge] Short-lived device relay loaded')
  initLanDirect(router)
}

/** 局域网直连 HTTP 上传端点，旁路设备码中继队列。
 * SRL APK 通过 CapacitorHttp 直连酒馆局域网地址（如 http://192.168.1.x:8000），
 * 不分块不排队不限流，实际速度取决于内网带宽。
 * 所有路径以 /api/plugins/srl-bridge/direct 为前缀，与 CF 中继互不干扰。 */
function initLanDirect(router) {
  const DIRECT_BASE = '/direct'
  const DIRECT_TTL = 5 * 60 * 1000

  const pendingDirect = new Map()
  let directCleanup

  function pruneDirect() {
    const now = Date.now()
    for (const [id, slot] of pendingDirect) {
      if (slot.expiresAt <= now) {
        for (const file of slot.files) {
          try { fs.unlinkSync(file.path) } catch (_) { /* ignore */ }
        }
        pendingDirect.delete(id)
      }
    }
  }

  if (!directCleanup) {
    directCleanup = setInterval(pruneDirect, 60_000)
    directCleanup.unref?.()
  }

  const sessionToken = randomToken(16)

  router.get(`${DIRECT_BASE}/handshake`, (_request, response) => {
    response.json({
      ok: true,
      name: 'SRL Bridge LAN Direct v1',
      sessionToken,
      maxFileSize: 256 * 1024 * 1024,
    })
  })

  router.post(`${DIRECT_BASE}/upload`, (request, response) => {
    const token = request.headers?.['x-srl-direct-token']
    if (!safeEqual(token, sessionToken)) {
      return response.status(403).json({ error: '直连会话令牌无效' })
    }

    const uploadId = randomToken(8)
    const tmpDir = fs.mkdtempSync('srl-direct-')
    const fileName = String(request.headers?.['x-srl-file-name'] || `direct-${uploadId}`).replace(/[/\\:]/g, '_')
    const chunks = []

    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const buffer = Buffer.concat(chunks)
      const tmpPath = `${tmpDir}/${fileName}`
      try {
        fs.writeFileSync(tmpPath, buffer)
        const mime = request.headers?.['content-type'] || 'application/octet-stream'
        if (!pendingDirect.has(uploadId)) {
          pendingDirect.set(uploadId, { files: [], expiresAt: Date.now() + DIRECT_TTL })
        }
        pendingDirect.get(uploadId).files.push({ name: fileName, mime, path: tmpPath })
        response.json({
          uploadId,
          fileName,
          size: buffer.length,
          sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
        })
      } catch (error) {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch (_) {}
        response.status(500).json({ error: error?.message || '写入文件失败' })
      }
    })
    request.on('error', () => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch (_) {}
    })
  })

  router.post(`${DIRECT_BASE}/commit`, (request, response) => {
    const token = request.headers?.['x-srl-direct-token']
    if (!safeEqual(token, sessionToken)) {
      return response.status(403).json({ error: '直连会话令牌无效' })
    }

    const uploadId = String(request.body?.uploadId ?? '').trim()
    const pending = pendingDirect.get(uploadId)
    if (!pending || pending.expiresAt <= Date.now()) {
      return response.status(404).json({ error: '上传批次不存在或已过期' })
    }

    const result = pending.files.map((file) => ({
      name: file.name,
      mime: file.mime,
      path: file.path,
      size: fs.statSync(file.path)?.size ?? 0,
    }))
    pendingDirect.delete(uploadId)
    response.json({ migrated: result.length, files: result })
  })

  router.post(`${DIRECT_BASE}/cleanup`, (request, response) => {
    const token = request.headers?.['x-srl-direct-token']
    if (!safeEqual(token, sessionToken)) {
      return response.status(403).json({ error: '直连会话令牌无效' })
    }

    const uploadId = String(request.body?.uploadId ?? '').trim()
    const pending = pendingDirect.get(uploadId)
    if (pending) {
      for (const file of pending.files) {
        try { fs.unlinkSync(file.path) } catch (_) {}
      }
      pendingDirect.delete(uploadId)
    }
    response.sendStatus(204)
  })
}

export async function exit() {
  clearInterval(cleanupTimer)
  for (const code of sessions.keys()) removeSession(code)
}
