import test from 'node:test'
import assert from 'node:assert/strict'
import { TavernAdapter } from '../modules/TavernAdapter.js'
import { BridgeController } from '../modules/BridgeController.js'
import { readChatArchive, createChatArchive } from '../modules/ChatArchive.js'

const original = '\ufeff{"user_name":"旅人","character_name":"同名角色"}\r\n{"name":"同名角色","is_user":false,"mes":"{{user}} <status>原文</status>"}\r\n'
function fixture() {
  const previous = { window: globalThis.window, fetch: globalThis.fetch }
  const calls = []
  const context = {
    characters: [{ name: '同名角色', avatar: 'a.png' }, { name: '同名角色', avatar: 'b.png' }],
    getRequestHeaders: () => ({ 'X-CSRF-Token': 'fixture' }),
  }
  globalThis.window = { SillyTavern: { getContext: () => context },
    addEventListener() {}, removeEventListener() {} }
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body); calls.push({ url, body })
    if (url === '/api/characters/chats') return Response.json([{ file_name: '雨夜.jsonl', file_size: '2.50 MB' }])
    if (url === '/api/chats/export') return Response.json({ result: original })
    if (url === '/api/characters/export') return new Response(body.avatar_url)
    throw new Error(`Unexpected request ${url}`)
  }
  return { calls, context, restore() { Object.assign(globalThis, previous) } }
}
test('lists saved chats on demand with host sizes and distinct avatar identities', async () => {
  const f = fixture()
  try {
    const items = await new TavernAdapter().listResources('chat')
    assert.equal(items.length, 2)
    assert.notEqual(items[0].id, items[1].id)
    assert.match(items[0].detail, /a.png/)
    assert.equal(items[0].sizeLabel, '2.50 MB')
    assert.ok(f.calls.every(({ url, body }) => url === '/api/characters/chats' && body.simple === false))
  } finally { f.restore() }
})
test('exports unchanged JSONL and the actual selected character PNG; never saves, switches or deletes chats', async () => {
  const f = fixture()
  try {
    const adapter = new TavernAdapter()
    const items = await adapter.listResources('chat')
    const archive = await adapter.exportResource(items[1])
    const result = await readChatArchive(archive)
    assert.equal(await result.card.text(), 'b.png')
    assert.deepEqual(new Uint8Array(await result.chat.arrayBuffer()), new TextEncoder().encode(original))
    assert.equal(result.avatar, 'b.png')
    assert.ok(f.calls.every(({ url }) => ['/api/characters/chats','/api/chats/export','/api/characters/export'].includes(url)))
    assert.equal(f.calls.find(({ url }) => url === '/api/chats/export').body.format, 'jsonl')
  } finally { f.restore() }
})
test('rejects forged/deleted identities before exporting any content', async () => {
  const f = fixture()
  try {
    const adapter = new TavernAdapter()
    for (const identity of [['../a.png','雨夜.jsonl'], ['a.png','../秘密.jsonl'], ['a.png','已删除.jsonl']])
      await assert.rejects(adapter.exportResource({ kind: 'chat', id: `chat:${JSON.stringify(identity)}` }), /不存在/)
    assert.ok(f.calls.every(({ url }) => url === '/api/characters/chats'))
  } finally { f.restore() }
})
test('rejects truncated archives and exports without a JSONL result', async () => {
  const f = fixture()
  try {
    const archive = createChatArchive(new File(['png'], 'a.png'), new File([original], '雨夜.jsonl'), 'a.png')
    await assert.rejects(readChatArchive(archive.slice(0,-1)), /不完整/)
    const fetcher = globalThis.fetch
    globalThis.fetch = (url, init) => url === '/api/chats/export' ? Promise.resolve(Response.json({ error: true })) : fetcher(url, init)
    await assert.rejects(new TavernAdapter().exportResource({ kind: 'chat', id: 'chat:["a.png","雨夜.jsonl"]' }), /原件/)
  } finally { f.restore() }
})

test('accepts chats over 64 MiB and character cards over 16 MiB within the shared file limit', async () => {
  const card = new File([new Uint8Array(17 * 1024 * 1024)], 'a.png')
  const chat = new File([new Uint8Array(65 * 1024 * 1024)], 'large.jsonl')
  const archive = createChatArchive(card, chat, 'a.png')
  const result = await readChatArchive(archive)
  assert.equal(result.card.size, card.size)
  assert.equal(result.chat.size, chat.size)
  assert.ok(archive.size > card.size + chat.size)
})

test('controller sends a validated chat archive through its existing file transport', async () => {
  const f = fixture()
  const controller = new BridgeController(new TavernAdapter())
  try {
    const files = []; const events = []
    controller.sendFile = async (file, kind) => files.push({ file, kind })
    controller.send = async (type, value) => events.push({ type, value })
    await controller.sendResources('chat-request', [{ id: 'chat:["a.png","雨夜.jsonl"]' }])
    assert.equal(files[0].kind, 'chat')
    assert.equal((await readChatArchive(files[0].file)).avatar, 'a.png')
    assert.equal(events.at(-1).value.completed, 1)
  } finally { controller.destroy(); f.restore() }
})


test('carries disabled/global/preset display rules and scope consent without exporting the preset itself', async () => {
  const f = fixture()
  try {
    const rule = {id:'r',scriptName:'面板',findRegex:'status',replaceString:'panel',markdownOnly:true,placement:[2]}
    f.context.extensionSettings = {regex:[rule,{...rule,id:'off',disabled:true},{...rule,id:'prompt',markdownOnly:false,promptOnly:true}],character_allowed_regex:['a.png'],preset_allowed_regex:{openai:['选择的预设']}}
    f.context.getPresetManager = () => ({apiId:'openai',getSelectedPresetName:()=> '选择的预设',readPresetExtensionField:()=> [rule]})
    const adapter = new TavernAdapter()
    const archive = await adapter.exportResource((await adapter.listResources('chat'))[0])
    const result = await readChatArchive(archive)
    assert.equal(result.displayRules.length,2)
    assert.equal(result.displayRules[1].disabled,true)
    assert.deepEqual(result.presetRules,[rule])
    assert.deepEqual(result.regexContext,{presetName:'选择的预设',presetEnabled:true,characterEnabled:true})
    assert.equal(await result.chat.text(),original.replace(/^\ufeff/,''))
    assert.ok(!f.calls.some(call => call.url.includes('preset')))
  } finally { f.restore() }
})
