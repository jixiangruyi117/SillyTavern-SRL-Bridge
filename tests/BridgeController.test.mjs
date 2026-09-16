import test from 'node:test'
import assert from 'node:assert/strict'

import { BridgeController } from '../modules/BridgeController.js'
import { envelope, sha256 } from '../modules/Protocol.js'

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
