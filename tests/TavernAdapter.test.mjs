import test from 'node:test'
import assert from 'node:assert/strict'

import { TavernAdapter } from '../modules/TavernAdapter.js'

function installContext(overrides = {}) {
  const context = {
    characters: [{ name: '测试角色', avatar: 'test.png', data: { creator: 'SRL' } }],
    getWorldInfoNames: () => ['测试世界书'],
    getRequestHeaders: () => ({ 'X-CSRF-Token': 'test' }),
    extensionSettings: { regex: [] },
    saveSettingsDebounced: () => {},
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
  assert.deepEqual(saved, {
    name: '默认预设 (SRL 2)',
    data: { temperature: 0.8 },
  })
  assert.deepEqual(result, { status: 'created', name: '默认预设 (SRL 2)' })
})

test('imports a global regex copy through extension settings', async () => {
  let saved = false
  const context = installContext({
    extensionSettings: {
      regex: [
        {
          id: 'old',
          scriptName: '清理思维链',
          findRegex: '/old/g',
          replaceString: '',
        },
      ],
    },
    saveSettingsDebounced: () => {
      saved = true
    },
  })
  const file = new File(
    [
      JSON.stringify({
        id: 'new',
        scriptName: '清理思维链',
        findRegex: '/new/g',
        replaceString: '',
      }),
    ],
    '清理思维链.json',
    { type: 'application/json' },
  )
  const result = await new TavernAdapter().importResource(file, 'regexGlobal', 'copy')
  assert.equal(context.extensionSettings.regex.length, 2)
  assert.equal(context.extensionSettings.regex[1].scriptName, '清理思维链 (SRL 2)')
  assert.equal(saved, true)
  assert.deepEqual(result, { status: 'created', name: '清理思维链' })
})

test('lists and imports character-scoped regex separately', async () => {
  let written
  installContext({
    characters: [
      {
        name: '测试角色',
        avatar: 'test.png',
        data: {
          extensions: { regex_scripts: [{ id: 'old', scriptName: '旧规则' }] },
        },
      },
    ],
    writeExtensionField: async (index, field, value) => {
      written = { index, field, value }
    },
  })
  const adapter = new TavernAdapter()
  const listed = await adapter.listResources()
  assert.equal(
    listed.some((item) => item.kind === 'regexCharacter'),
    true,
  )

  const file = new File(
    [
      JSON.stringify({
        scoped: [{ id: 'new', scriptName: '新规则' }],
        sourceName: '测试角色',
      }),
    ],
    '角色正则.json',
    { type: 'application/json' },
  )
  await adapter.importResource(file, 'regexCharacter', 'overwrite')
  assert.deepEqual(written, {
    index: 0,
    field: 'regex_scripts',
    value: [{ id: 'new', scriptName: '新规则' }],
  })
})

test('lists and imports preset-scoped regex separately', async () => {
  let written
  installContext({
    getPresetManager: async () => ({
      getAllPresets: async () => ['默认预设'],
      getCompletionPresetByName: async () => ({
        name: '默认预设',
        extensions: { regex_scripts: [{ id: 'old', scriptName: '旧规则' }] },
      }),
      writePresetExtensionField: async (value) => {
        written = value
      },
    }),
  })
  const adapter = new TavernAdapter()
  const listed = await adapter.listResources()
  assert.equal(
    listed.some((item) => item.kind === 'regexPreset'),
    true,
  )

  const file = new File(
    [
      JSON.stringify({
        preset: [{ id: 'new', scriptName: '新规则' }],
        sourceName: '默认预设',
      }),
    ],
    '预设正则.json',
    { type: 'application/json' },
  )
  await adapter.importResource(file, 'regexPreset', 'overwrite')
  assert.deepEqual(written, {
    name: '默认预设',
    path: 'regex_scripts',
    value: [{ id: 'new', scriptName: '新规则' }],
  })
})
