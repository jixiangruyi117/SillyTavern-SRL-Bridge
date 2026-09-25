import test from 'node:test'
import assert from 'node:assert/strict'

import { BridgeController } from '../modules/BridgeController.js'
import { RelayPort } from '../modules/RelayPort.js'
import { envelope, sha256 } from '../modules/Protocol.js'

test('local direct accepts Chinese filenames and keeps the original name in the envelope', async () => {
  const previousFetch = globalThis.fetch
  const previousWindow = globalThis.window
  globalThis.window = { location: { origin: 'http://127.0.0.1:8000' }, addEventListener() {}, removeEventListener() {} }
  const controller = new BridgeController({ context: { getRequestHeaders: () => ({}) } })
  const messages = []
  const file = new File(['example'], '中文人设与聊天'.repeat(50) + '.srlchat')
  controller.createLocalDirectSession = async () => ({ sessionId: 'session_123456', token: 'a'.repeat(32), origin: 'http://127.0.0.1:8000', maxFileSize: 1024 })
  controller.send = async (type, value) => messages.push({ type, ...value })
  controller.sendFileChunks = async () => assert.fail('valid local upload must not fall back')
  globalThis.fetch = async (_url, init) => {
    const headers = new Headers(init.headers)
    assert.equal(headers.has('X-SRL-File-Name'), false)
    return Response.json({ size: file.size, sha256: await sha256(file) })
  }
  try {
    await controller.sendFile(file, 'chat', 'request', '聊天', true)
    assert.equal(messages[0].type, 'file-start')
    assert.equal(messages[0].name, file.name)
    assert.equal(messages[0].localDirectSession.sessionId, 'session_123456')
    assert.equal(messages[1].type, 'file-end')
  } finally { controller.destroy(); globalThis.fetch = previousFetch; globalThis.window = previousWindow }
})

test('reuses an unexpired device code, coalesces clicks and respects a disconnect during creation', async () => {
  const previousWindow = globalThis.window
  const previousFetch = globalThis.fetch
  const previousStart = RelayPort.prototype.start
  globalThis.window = { location: { origin: 'https://tavern.test' }, addEventListener() {}, removeEventListener() {} }
  RelayPort.prototype.start = () => {}
  let release; let creates = 0
  globalThis.fetch = async (url) => {
    if (!String(url).endsWith('/sessions')) return new Response(null, { status: 204 })
    creates++
    await new Promise((resolve) => { release = resolve })
    return Response.json({ code: 'AB23CD45', pairCode: '123456', controllerToken: 'a'.repeat(32), expiresAt: Date.now() + 120000 })
  }
  const controller = new BridgeController({ context: { getRequestHeaders: () => ({}) } })
  try {
    const first = controller.openDevice('https://srl.test/')
    assert.equal(first, controller.openDevice('https://srl.test/'))
    release(); const session = await first
    assert.deepEqual(await controller.openDevice('https://srl.test/'), session)
    assert.equal(creates, 1)
    const renewal = controller.openDevice('https://srl.test/', { renew: true })
    controller.disconnect()
    release()
    await assert.rejects(renewal, /已取消/)
    assert.equal(controller.port, null)
    assert.equal(creates, 2)
  } finally {
    controller.destroy(); globalThis.window = previousWindow; globalThis.fetch = previousFetch; RelayPort.prototype.start = previousStart
  }
})

test('clears an expired local APK request instead of retaining an unusable allow button', async () => {
  const previousWindow = globalThis.window
  const previousFetch = globalThis.fetch
  globalThis.window = {
    location: { origin: 'http://127.0.0.1:8000' },
    addEventListener() {},
    removeEventListener() {},
    setInterval,
    clearInterval,
  }
  const responses = [
    { requests: [{ code: 'AB23CD45' }] },
    { requests: [] },
  ]
  globalThis.fetch = async () => new Response(JSON.stringify(responses.shift()), { status: 200 })
  const controller = new BridgeController({ context: { getRequestHeaders: () => ({}) } })
  const requests = []
  controller.addEventListener('local-pair-request', (event) => requests.push(event.detail))
  try {
    await controller.pollLocalPairRequest()
    await controller.pollLocalPairRequest()

    assert.deepEqual(requests, [{ code: 'AB23CD45' }, null])
    assert.equal(controller.localPairRequest, undefined)
  } finally {
    controller.destroy()
    globalThis.window = previousWindow
    globalThis.fetch = previousFetch
  }
})

test('serializes local pairing polls instead of stacking slow requests', async () => {
  const previousWindow = globalThis.window
  const previousFetch = globalThis.fetch
  let release
  let calls = 0
  globalThis.window = {
    location: { origin: 'http://127.0.0.1:8000' },
    addEventListener() {},
    removeEventListener() {},
  }
  globalThis.fetch = async () => {
    calls += 1
    await new Promise((resolve) => { release = resolve })
    return new Response(JSON.stringify({ requests: [] }), { status: 200 })
  }
  const controller = new BridgeController({ context: { getRequestHeaders: () => ({}) } })
  try {
    const first = controller.pollLocalPairRequest()
    const second = controller.pollLocalPairRequest()
    assert.equal(first, second)
    release()
    await first
    assert.equal(calls, 1)
  } finally {
    controller.destroy()
    globalThis.window = previousWindow
    globalThis.fetch = previousFetch
  }
})

test('bounds simultaneous incoming transfers and rejects oversized chunks', async () => {
  const previousWindow = globalThis.window
  globalThis.window = {
    location: { origin: 'https://tavern.example' },
    addEventListener() {},
    removeEventListener() {},
  }
  const controller = new BridgeController({ context: {} })
  const meta = (transferId) => ({
    direction: 'to-tavern',
    transferId,
    size: 1,
    name: `${transferId}.json`,
    mimeType: 'application/json',
    kind: 'theme',
    sha256: 'unused',
  })
  try {
    await controller.startIncoming(meta('one'))
    await controller.startIncoming(meta('two'))
    await controller.startIncoming(meta('three'))
    await assert.rejects(controller.startIncoming(meta('four')), /同时接收的文件过多/)
    assert.throws(
      () => controller.receiveChunk({ transferId: 'one', index: 0, data: new ArrayBuffer(2 ** 18 + 1) }),
      /文件分块超过限制/,
    )
    assert.equal(controller.incoming.has('one'), false)
  } finally {
    controller.destroy()
    globalThis.window = previousWindow
  }
})


test('retired preview requests never import data; regular transfer and capabilities remain available', async () => {
  const previousWindow = globalThis.window
  globalThis.window = {
    location: { origin: 'https://tavern.example' },
    addEventListener() {}, removeEventListener() {}, clearInterval,
  }
  const imported = []
  const sent = []
  const controller = new BridgeController({
    context: {},
    async importResource(file, kind, policy) {
      imported.push({ text: await file.text(), kind, policy })
      return { status: 'imported' }
    },
  })
  controller.port = { postMessage: (message) => sent.push(message), close() {} }
  try {
    await controller.handlePortMessage(envelope('srl-accept', { pairCode: '' }))
    const ready = sent.find((message) => message.type === 'st-ready')
    assert.ok(ready)
    assert.ok(ready.capabilities.includes('character'))
    assert.ok(ready.capabilities.includes('theme'))
    assert.ok(ready.capabilities.includes('persona-avatar-check-v1'))
    assert.ok(!ready.capabilities.includes('live-preview-v1'))
    await assert.rejects(
      controller.startIncoming({ direction: 'to-tavern-preview', transferId: 'old-preview', size: 2 }),
      /不支持的传输方向/,
    )
    assert.equal(controller.incoming.size, 0)
    await controller.finishIncoming({ transferId: 'old-preview' })
    assert.equal(imported.length, 0)

    const file = new File(['{"name":"retained transfer"}'], 'theme.json', { type: 'application/json' })
    const meta = { direction: 'to-tavern', transferId: 'regular', requestId: 'req', name: file.name,
      mimeType: file.type, kind: 'theme', conflictPolicy: 'skip', size: file.size, sha256: await sha256(file) }
    await controller.startIncoming(meta)
    controller.receiveChunk({ transferId: 'regular', index: 0, data: await file.arrayBuffer() })
    await controller.finishIncoming({ transferId: 'regular', requestId: 'req' })
    assert.deepEqual(imported, [{ text: await file.text(), kind: 'theme', policy: 'skip' }])
    assert.ok(sent.some((message) => message.type === 'file-result' && message.result.status === 'imported'))
  } finally {
    controller.destroy()
    globalThis.window = previousWindow
  }
})

test('avatar check reports exact existing names without importing or uploading', async () => {
  const previousWindow = globalThis.window
  globalThis.window = {
    location: { origin: 'https://tavern.example' },
    addEventListener() {}, removeEventListener() {}, clearInterval,
  }
  const sent = []
  const controller = new BridgeController({
    context: {},
    listUserAvatarIds: async () => ['alice.png', 'alice-old.png'],
  })
  controller.port = { postMessage: (message) => sent.push(message), close() {} }
  try {
    await controller.handlePortMessage(envelope('persona-avatar-check-request', {
      requestId: 'avatar-check', avatarIds: ['alice.png', 'bob.png'],
    }))
    const response = sent.find((message) => message.type === 'persona-avatar-check-response')
    assert.equal(response.requestId, 'avatar-check')
    assert.deepEqual(response.existingIds, ['alice.png'])
  } finally {
    controller.destroy()
    globalThis.window = previousWindow
  }
})

test('TauriTavern only uses HTTPS device relay and blocks all server-plugin transports', async () => {
  const previousWindow = globalThis.window
  const previousFetch = globalThis.fetch
  const requests = []
  globalThis.window = {
    location: { origin: 'http://tauri.localhost' },
    addEventListener() {}, removeEventListener() {}, clearInterval,
  }
  globalThis.fetch = async (url) => {
    requests.push(String(url))
    throw new Error('relay offline')
  }
  const controller = new BridgeController({ context: { getRequestHeaders: () => ({}) } }, {
    kind: 'tauritavern', label: 'TauriTavern', isTauriTavern: true,
    supportsPopupPairing: false, supportsServerPlugin: false,
  })
  try {
    assert.throws(() => controller.open('https://srl.example/'), /TauriTavern.*设备码/)
    assert.equal(controller.canUseLocalDirect(), false)
    assert.equal(await controller.startLocalAutoPairing(), false)
    await assert.rejects(controller.registerLocalAutoPairing(), /不支持本机服务端插件/)
    await assert.rejects(controller.approveLocalAutoPairing(), /不支持本机服务端插件/)
    await assert.rejects(controller.openDevice('http://srl.example/'), /必须使用 HTTPS/)
    await assert.rejects(controller.openDevice('https://srl.example/'), /不支持 Node 服务端插件/)
    assert.deepEqual(requests, ['https://srl.example/api/bridge/sessions'])
    await assert.rejects(controller.createLocalDirectSession(), /不支持本机服务端插件/)
    assert.throws(() => controller.localDirectUrl({ sessionId: 'abcdefghijkl' }), /不支持本机服务端插件/)
    assert.equal(controller.readLocalDirectSession({
      origin: window.location.origin,
      sessionId: 'abcdefghijkl',
      token: 'abcdefghijklmnopqrstuvwxyz0123456789',
      maxFileSize: 1024,
    }), undefined)
    assert.deepEqual(requests, ['https://srl.example/api/bridge/sessions'])
    await assert.rejects(controller.startIncoming({
      direction: 'to-tavern', transferId: 'forced-local', size: 1,
      name: 'forced.json', mimeType: 'application/json',
      localDirectSession: { origin: window.location.origin, sessionId: 'abcdefghijkl',
        token: 'abcdefghijklmnopqrstuvwxyz0123456789', maxFileSize: 1024 },
    }), /无效的本机直传会话/)
    assert.deepEqual(requests, ['https://srl.example/api/bridge/sessions'])
  } finally {
    controller.destroy()
    globalThis.window = previousWindow
    globalThis.fetch = previousFetch
  }
})

test('SillyTavern still falls back to the server plugin when HTTPS relay is unavailable', async () => {
  const previousWindow = globalThis.window
  const previousFetch = globalThis.fetch
  const requests = []
  globalThis.window = {
    location: { origin: 'http://127.0.0.1:8000' },
    addEventListener() {}, removeEventListener() {},
  }
  globalThis.fetch = async (url) => {
    requests.push(String(url))
    if (requests.length === 1) throw new Error('HTTPS relay offline')
    return new Response(JSON.stringify({ code: 'AB23CD45', pairCode: '123456',
      controllerToken: 'a'.repeat(32) }), { status: 200 })
  }
  const controller = new BridgeController({ context: { getRequestHeaders: () => ({}) } })
  try {
    await controller.openDevice('https://srl.example/')
    assert.deepEqual(requests.slice(0, 2), [
      'https://srl.example/api/bridge/sessions',
      '/api/plugins/srl-bridge/sessions',
    ])
    assert.ok(requests.some((url) => url.endsWith('/api/plugins/srl-bridge/poll')))
    assert.equal(controller.deviceCode, 'AB23CD45')
  } finally {
    controller.destroy()
    globalThis.window = previousWindow
    globalThis.fetch = previousFetch
  }
})

test('TauriTavern rejects HTTPS sessions routed through the server-plugin path', async () => {
  const previousWindow = globalThis.window
  const previousFetch = globalThis.fetch
  const requests = []
  let relayPath = '/api/plugins/srl-bridge/'
  globalThis.window = {
    location: { origin: 'http://tauri.localhost' },
    addEventListener() {}, removeEventListener() {},
  }
  globalThis.fetch = async (url) => {
    requests.push(String(url))
    return new Response(JSON.stringify({ code: 'AB23CD45', pairCode: '123456',
      controllerToken: 'a'.repeat(32), relayBase: relayPath }), { status: 200 })
  }
  const controller = new BridgeController({ context: { getRequestHeaders: () => ({}) } }, {
    kind: 'tauritavern', label: 'TauriTavern', isTauriTavern: true,
    supportsPopupPairing: false, supportsServerPlugin: false,
  })
  try {
    await assert.rejects(controller.openDevice('https://srl.example/'), /Node 服务端插件路径/)
    relayPath = '/api/plugins%2fsrl-bridge/sessions'
    await assert.rejects(controller.openDevice('https://srl.example/'), /Node 服务端插件路径/)
    assert.deepEqual(requests, [
      'https://srl.example/api/bridge/sessions',
      'https://srl.example/api/bridge/sessions',
    ])
  } finally {
    controller.destroy()
    globalThis.window = previousWindow
    globalThis.fetch = previousFetch
  }
})

test('TauriTavern establishes its device-code session through the HTTPS relay', async () => {
  const previousWindow = globalThis.window
  const previousFetch = globalThis.fetch
  const requests = []
  globalThis.window = {
    location: { origin: 'http://tauri.localhost' },
    addEventListener() {}, removeEventListener() {},
  }
  globalThis.fetch = async (url) => {
    const address = String(url)
    requests.push(address)
    if (address === 'https://srl.example/api/bridge/sessions') {
      return new Response(JSON.stringify({ code: 'AB23CD45', pairCode: '123456',
        controllerToken: 'a'.repeat(32), relayBase: '/api/bridge/' }), { status: 200 })
    }
    if (address === 'https://srl.example/api/bridge/poll') {
      return new Response(JSON.stringify({ closed: true, messages: [] }), { status: 200 })
    }
    return new Response(null, { status: 204 })
  }
  const controller = new BridgeController({ context: { getRequestHeaders: () => ({}) } }, {
    kind: 'tauritavern', label: 'TauriTavern', isTauriTavern: true,
    supportsPopupPairing: false, supportsServerPlugin: false,
  })
  try {
    const session = await controller.openDevice('https://srl.example/library')
    assert.equal(session.code, 'AB23CD45')
    assert.equal(controller.deviceCode, 'AB23CD45')
    assert.equal(controller.port.remote, true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.ok(requests.includes('https://srl.example/api/bridge/poll'))
    assert.ok(requests.every((url) => !url.includes('/api/plugins/srl-bridge/')))
  } finally {
    controller.destroy()
    globalThis.window = previousWindow
    globalThis.fetch = previousFetch
  }
})
