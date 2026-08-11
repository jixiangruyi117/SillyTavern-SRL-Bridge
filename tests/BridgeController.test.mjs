import test from 'node:test'
import assert from 'node:assert/strict'

import { BridgeController } from '../modules/BridgeController.js'

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
