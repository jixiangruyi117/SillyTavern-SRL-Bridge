import test from 'node:test'
import assert from 'node:assert/strict'

import { BridgeController } from '../modules/BridgeController.js'
import { TavernAdapter } from '../modules/TavernAdapter.js'
import { waitForHostReady } from '../modules/HostRuntime.js'
import { envelope } from '../modules/Protocol.js'

test('TauriTavern ready context exports and sends a named global regex without plugin requests', async () => {
  const previousWindow = globalThis.window
  const previousFetch = globalThis.fetch
  const requests = []
  const context = {
    version: 'TauriTavern integration test',
    characters: [],
    extensionSettings: { regex: [{
      id: 'strip-prefix', scriptName: '移除提示前缀', findRegex: '^提示：', replaceString: '',
    }] },
    powerUserSettings: { personas: {}, persona_descriptions: {} },
    getWorldInfoNames: () => [],
    getRequestHeaders: () => ({}),
    getPresetManager: async () => ({ getAllPresets: async () => [] }),
  }
  globalThis.window = {
    location: { origin: 'http://tauri.localhost' },
    __TAURITAVERN__: { ready: Promise.resolve() },
    SillyTavern: { getContext: () => context },
    addEventListener() {}, removeEventListener() {}, clearInterval,
  }
  globalThis.fetch = async (url) => {
    const path = String(url)
    requests.push(path)
    if (path === '/api/settings/get') return new Response(JSON.stringify({ themes: [] }), { status: 200 })
    throw new Error(`Unexpected network request: ${path}`)
  }

  const controller = new BridgeController(new TavernAdapter())
  const sent = []
  controller.port = {
    postMessage: async (message) => {
      sent.push(message)
      if (message.type === 'file-chunk') controller.resolveChunkAck(message)
    },
    close() {},
  }

  try {
    const ready = await waitForHostReady()
    assert.equal(ready.host.isTauriTavern, true)
    assert.equal(ready.host.supportsServerPlugin, false)
    assert.equal(ready.context, context)
    await controller.handlePortMessage(envelope('srl-accept', { pairCode: '' }))
    const readyMessage = sent.find((message) => message.type === 'st-ready')
    assert.ok(readyMessage)
    assert.ok(!readyMessage.capabilities.includes('local-direct-v1'))

    const [item] = (await controller.adapter.listResources()).filter((resource) => resource.kind === 'regexGlobal')
    assert.equal(item.name, '移除提示前缀')
    const exported = await controller.adapter.exportResource(item)
    const data = JSON.parse(await exported.text())
    assert.equal(exported.name, '移除提示前缀.json')
    assert.equal(data.sourceName, '移除提示前缀')
    assert.equal(data.global[0].scriptName, '移除提示前缀')

    await controller.sendResources('tt-regex-test', [{ id: item.id }])
    const start = sent.find((message) => message.type === 'file-start')
    assert.equal(start.direction, 'to-srl')
    assert.equal(start.kind, 'regexGlobal')
    assert.equal(start.name, '移除提示前缀.json')
    assert.equal(start.displayName, '移除提示前缀')
    assert.equal(sent.at(-1).type, 'pull-complete')
    assert.ok(requests.length > 0)
    assert.ok(requests.every((path) => !path.startsWith('/api/plugins/srl-bridge/')))
  } finally {
    controller.destroy()
    globalThis.window = previousWindow
    globalThis.fetch = previousFetch
  }
})
