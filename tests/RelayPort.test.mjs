import test from 'node:test'
import assert from 'node:assert/strict'

import { RelayPort } from '../modules/RelayPort.js'
import { BridgeController } from '../modules/BridgeController.js'

test('a negotiated relay retries a temporary upload with the same id, but reports an expired session immediately', async () => {
  const oldWindow = globalThis.window
  const oldFetch = globalThis.fetch
  globalThis.window = { location: { origin: 'https://tavern.example' } }
  let calls = []
  globalThis.fetch = async (_url, init) => {
    calls.push(JSON.parse(init.body))
    return calls.length === 1 ? new Response(JSON.stringify({ message: 'temporary' }), { status: 503 }) : new Response(null, { status: 204 })
  }
  try {
    const port = new RelayPort({}, { code: 'AB23CD45', controllerToken: 'token', reliableDelivery: true }, 'https://srl.example/api/bridge/')
    await port.postMessage({ type: 'file-end' })
    assert.equal(calls.length, 2)
    assert.equal(calls[0].messageId, calls[1].messageId)
    calls = []
    globalThis.fetch = async () => { calls.push('expired'); return new Response(JSON.stringify({ message: 'expired' }), { status: 410 }) }
    await assert.rejects(port.postMessage({ type: 'file-end' }), /expired/)
    assert.equal(calls.length, 1)
  } finally { globalThis.window = oldWindow; globalThis.fetch = oldFetch }
})

test('poll acknowledges only handled messages and suppresses a repeated delivery', async () => {
  const oldWindow = globalThis.window
  globalThis.window = { location: { origin: 'https://tavern.example' } }
  try {
    const port = new RelayPort({}, { code: 'AB23CD45', controllerToken: 'token', reliableDelivery: true })
    const requests = []; const handled = []
    port.request = async (_path, body) => {
      requests.push(body)
      if (requests.length === 3) return { closed: true }
      return { messages: [{ type: 'file-end' }], deliveryIds: ['delivery-1'] }
    }
    port.onmessage = async ({ data }) => { handled.push(data) }
    await port.poll()
    assert.equal(handled.length, 1)
    assert.deepEqual(requests[1].acknowledgements, ['delivery-1'])
    assert.deepEqual(requests[2].acknowledgements, ['delivery-1'])
  } finally { globalThis.window = oldWindow }
})

test('a failed control request does not prevent later control messages', async () => {
  const oldWindow = globalThis.window
  globalThis.window = { location: { origin: 'https://tavern.example' } }
  try {
    const port = new RelayPort({}, { code: 'AB23CD45', controllerToken: 'token' })
    const delivered = []
    port.request = async (_path, body) => {
      if (body.message.type === 'first') throw new Error('temporary network failure')
      delivered.push(body.message.type)
    }
    await assert.rejects(port.postMessage({ type: 'first' }), /temporary/)
    await port.postMessage({ type: 'second' })
    assert.deepEqual(delivered, ['second'])
  } finally { globalThis.window = oldWindow }
})

test('closes a same-origin relay with unload-safe Beacon and keepalive fetch', async () => {
  const oldWindow = globalThis.window
  const oldNavigator = globalThis.navigator
  const oldFetch = globalThis.fetch
  const beacons = []
  const requests = []
  globalThis.window = { location: { origin: 'http://127.0.0.1:8000' } }
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { sendBeacon: (url, body) => { beacons.push([url.href ?? url, body]); return true } },
  })
  globalThis.fetch = async (url, options) => {
    requests.push([url.href ?? url, options])
    return new Response(null, { status: 204 })
  }
  try {
    const port = new RelayPort(
      { getRequestHeaders: () => ({ 'Content-Type': 'application/json' }) },
      { code: 'AB23CD45', controllerToken: 'token' },
    )
    port.close()
    await Promise.resolve()
    assert.equal(beacons.length, 1)
    assert.equal(beacons[0][0], 'http://127.0.0.1:8000/api/plugins/srl-bridge/close')
    assert.deepEqual(JSON.parse(await beacons[0][1].text()), {
      code: 'AB23CD45', token: 'token',
    })
    assert.equal(requests[0][1].keepalive, true)
    port.close()
    assert.equal(beacons.length, 1)
  } finally {
    globalThis.window = oldWindow
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: oldNavigator })
    globalThis.fetch = oldFetch
  }
})

test('file chunks bypass the control-message queue and can use the in-flight window', async () => {
  const oldWindow = globalThis.window
  const oldFetch = globalThis.fetch
  let releaseControl
  const calls = []
  globalThis.window = { location: { origin: 'http://tauri.localhost' } }
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) })
    if (calls.length === 1) await new Promise((resolve) => { releaseControl = resolve })
    return new Response(null, { status: 204 })
  }
  try {
    const port = new RelayPort({}, { code: 'AB23CD45', controllerToken: 'token' }, 'https://relay.example/api/bridge/')
    const control = port.postMessage({ type: 'file-start' })
    await new Promise((resolve) => setImmediate(resolve))
    const chunk = port.postFileChunk({ type: 'file-chunk', index: 0 })
    await new Promise((resolve) => setImmediate(resolve))

    assert.equal(calls.length, 2)
    assert.deepEqual(calls.map((call) => call.body.message.type), ['file-start', 'file-chunk'])

    releaseControl()
    await Promise.all([control, chunk])
    port.close()
  } finally {
    globalThis.window = oldWindow
    globalThis.fetch = oldFetch
  }
})

test('BridgeController routes only file chunks through the relay chunk lane', async () => {
  const oldWindow = globalThis.window
  globalThis.window = { location: { origin: 'https://tavern.example' }, addEventListener() {}, removeEventListener() {} }
  const messages = []
  const chunks = []
  const controller = new BridgeController({ context: {} })
  controller.port = {
    postMessage: (message) => messages.push(message),
    postFileChunk: (message) => chunks.push(message),
    close() {},
  }
  try {
    controller.send('file-start', { transferId: 'transfer' })
    controller.send('file-chunk', { transferId: 'transfer', index: 0 })
    controller.send('file-end', { transferId: 'transfer' })

    assert.deepEqual(messages.map(({ type }) => type), ['file-start', 'file-end'])
    assert.deepEqual(chunks.map(({ type }) => type), ['file-chunk'])
  } finally {
    controller.destroy()
    globalThis.window = oldWindow
  }
})
