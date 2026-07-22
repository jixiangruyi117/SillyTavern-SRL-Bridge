import test from 'node:test'
import assert from 'node:assert/strict'

import { TavernAdapter } from '../modules/TavernAdapter.js'

function installContext(overrides = {}) {
  const context = {
    characters: [{ name: '测试角色', avatar: 'test.png', data: { creator: 'SRL' } }],
    getWorldInfoNames: () => ['测试世界书'],
    getRequestHeaders: () => ({ 'X-CSRF-Token': 'test' }),
    updateWorldInfoList: async () => {},
    getPresetManager: async () => ({
      getAllPresets: async () => ['默认预设'],
      getCompletionPresetByName: async (name) => ({ name }),
      savePreset: async () => {},
    }),
    ...overrides,
  }
  globalThis.window = { SillyTavern: { getContext: () => context } }
  return context
}

test('lists supported resources exposed by SillyTavern context', async () => {
  installContext()
  const items = await new TavernAdapter().listResources()
  assert.deepEqual(
    items.map(({ kind, name }) => [kind, name]),
    [
      ['character', '测试角色'],
      ['worldBook', '测试世界书'],
      ['preset', '默认预设'],
    ],
  )
})

test('imports a world book through the official endpoint and refreshes the list', async () => {
  let refreshed = false
  let request
  installContext({
    getWorldInfoNames: () => ['同名世界书'],
    updateWorldInfoList: async () => {
      refreshed = true
    },
  })
  globalThis.fetch = async (url, options) => {
    request = { url, options }
    return new Response(JSON.stringify({ name: '同名世界书' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  const file = new File([JSON.stringify({ entries: {} })], '同名世界书.json', {
    type: 'application/json',
  })
  const result = await new TavernAdapter().importResource(file, 'worldBook', 'overwrite')
  assert.equal(request.url, '/api/worldinfo/import')
  assert.equal(request.options.method, 'POST')
  assert.equal(request.options.body instanceof FormData, true)
  assert.equal(refreshed, true)
  assert.deepEqual(result, { status: 'overwritten', name: '同名世界书' })
})

test('creates a conflict-safe preset copy without replacing the original', async () => {
  let saved
  installContext({
    getPresetManager: async () => ({
      getAllPresets: async () => ['默认预设'],
      savePreset: async (name, data) => {
        saved = { name, data }
      },
    }),
  })
  const file = new File([JSON.stringify({ temperature: 0.8 })], '默认预设.json', {
    type: 'application/json',
  })
  const result = await new TavernAdapter().importResource(file, 'preset', 'copy')
  assert.deepEqual(saved, { name: '默认预设 (SRL 2)', data: { temperature: 0.8 } })
  assert.deepEqual(result, { status: 'created', name: '默认预设 (SRL 2)' })
})
