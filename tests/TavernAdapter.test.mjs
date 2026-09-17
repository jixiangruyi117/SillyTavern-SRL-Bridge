import test from 'node:test'
import assert from 'node:assert/strict'

import { TavernAdapter } from '../modules/TavernAdapter.js'

function installContext(overrides = {}) {
  const context = {
    characters: [{ name: '测试角色', avatar: 'test.png', data: { creator: 'SRL' } }],
    getWorldInfoNames: () => ['测试世界书'],
    getRequestHeaders: () => ({ 'X-CSRF-Token': 'test' }),
    extensionSettings: { regex: [] },
    powerUserSettings: { personas: {}, persona_descriptions: {} },
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

test('uploads a persona avatar through the official avatar endpoint then writes persona fields to powerUserSettings', async () => {
  let request
  const context = installContext({
    powerUserSettings: {
      personas: {},
      persona_descriptions: {},
      default_persona: null,
    },
  })
  globalThis.fetch = async (url, options) => {
    request = { url, options }
    return new Response(url === '/api/avatars/get' ? '["alice.png"]' : '{}', {
      status: 200,
    })
  }
  const adapter = new TavernAdapter()
  const avatar = new File(['png'], 'alice.png', { type: 'image/png' })
  await adapter.importResource(avatar, 'userAvatar', 'overwrite', {
    targetName: 'alice.png',
  })
  assert.equal(request.url, '/api/avatars/upload')
  assert.equal(request.options.body instanceof FormData, true)

  const persona = new File(
    [
      JSON.stringify({
        personas: { 'alice.png': 'Alice' },
        persona_descriptions: {
          'alice.png': { description: 'Archivist', position: 0 },
        },
        default_persona: 'alice.png',
      }),
    ],
    'personas.json',
    { type: 'application/json' },
  )
  await adapter.importResource(persona, 'userPersona', 'overwrite')
  assert.equal(context.powerUserSettings.personas['alice.png'], 'Alice')
  assert.equal(context.powerUserSettings.persona_descriptions['alice.png'].description, 'Archivist')
  assert.equal(context.powerUserSettings.default_persona, 'alice.png')
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

test('lists and exports one user persona without avatars or unrelated settings and preserves descriptors', async () => {
  const descriptor = {
    title: '备注',
    description: '{{user}} 与 {{char}}',
    position: 4,
    depth: 3,
    role: 1,
    lorebook: '世界书',
    connections: [{ type: 'character', id: 'test.png' }],
    extensionField: { keep: true },
  }
  const settings = {
    personas: { 'alice.png': 'Alice', 'bob.png': 'Bob' },
    persona_descriptions: {
      'alice.png': descriptor,
      'bob.png': { description: '其他人设' },
    },
    default_persona: 'bob.png',
    unrelatedSecret: 'not-exported',
  }
  installContext({ powerUserSettings: settings })
  const before = JSON.stringify(settings)
  const adapter = new TavernAdapter()
  const items = (await adapter.listResources()).filter((item) => item.kind === 'userPersona')
  assert.equal(items.length, 2)
  const alice = items.find((item) => item.name === 'Alice')
  assert.equal(alice.detail, '备注')
  const file = await adapter.exportResource(alice)
  assert.equal(file.type, 'application/json')
  assert.deepEqual(JSON.parse(await file.text()), {
    personas: { 'alice.png': 'Alice' },
    persona_descriptions: { 'alice.png': descriptor },
  })
  const bob = JSON.parse(
    await (await adapter.exportResource(items.find((item) => item.name === 'Bob'))).text(),
  )
  assert.equal(bob.default_persona, 'bob.png')
  assert.equal(JSON.stringify(settings), before)
  delete settings.personas['alice.png']
  await assert.rejects(adapter.exportResource(alice), /找不到用户人设/)
})

test('creates missing persona keys with the Tavern default avatar, without transferring the SRL cover', async () => {
  const context = installContext()
  const uploads = []
  globalThis.fetch = async (url, options) => {
    if (url === '/api/avatars/get') return new Response('[]')
    if (url === '/img/user-default.png') return new Response('host-default-image')
    assert.equal(url, '/api/avatars/upload')
    uploads.push([options.body.get('overwrite_name'), await options.body.get('avatar').text()])
    return new Response('{}')
  }
  const file = new File(
    [
      JSON.stringify({
        personas: { 'new.png': '新用户' },
        persona_descriptions: { 'new.png': { description: '设定' } },
      }),
    ],
    'personas.json',
  )
  await new TavernAdapter().importUserPersona(file, 'copy')
  assert.deepEqual(uploads, [['new.png', 'host-default-image']])
  assert.equal(context.powerUserSettings.personas['new.png'], '新用户')
})

test('a conflicting persona batch or failed default-avatar upload never partially changes persona settings', async () => {
  const context = installContext({
    powerUserSettings: {
      personas: { 'old.png': '原人设' },
      persona_descriptions: {},
    },
  })
  const original = JSON.stringify(context.powerUserSettings)
  const file = new File(
    [
      JSON.stringify({
        personas: { 'new.png': '新用户', 'old.png': '覆盖' },
        persona_descriptions: {},
      }),
    ],
    'personas.json',
  )
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return new Response('[]')
  }
  const adapter = new TavernAdapter()
  await assert.rejects(adapter.importUserPersona(file, 'copy'), /保留两份/)
  assert.equal(calls, 0)
  assert.equal(JSON.stringify(context.powerUserSettings), original)
  globalThis.fetch = async (url) =>
    url === '/api/avatars/get' ? new Response('[]') : new Response('', { status: 500 })
  await assert.rejects(adapter.importUserPersona(file, 'overwrite'), /默认头像/)
  assert.equal(JSON.stringify(context.powerUserSettings), original)
})
