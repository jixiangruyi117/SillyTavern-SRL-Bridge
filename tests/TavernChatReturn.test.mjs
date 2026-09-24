import test from 'node:test'
import assert from 'node:assert/strict'
import { TavernAdapter } from '../modules/TavernAdapter.js'

test('returns an unchanged JSONL to the confirmed avatar without switching or replacing a live chat', async () => {
  const previous = { window: globalThis.window, fetch: globalThis.fetch }
  const calls = []
  const context = { name1: 'User', characters: [{ name: '同名', avatar: 'a.png' }, { name: '同名', avatar: 'b.png' }], getRequestHeaders: () => ({}) }
  globalThis.window = { SillyTavern: { getContext: () => context } }
  const raw = '{"user_name":"User"}\r\n{"mes":"原文 {{user}}","swipes":["另一个回复"]}\r\n'
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: init.body })
    assert.equal(url, '/api/chats/import')
    return Response.json({ res: true, fileNames: ['新记录.jsonl'] })
  }
  try {
    const adapter = new TavernAdapter()
    const file = new File(['\ufeff' + raw], '雨夜.jsonl')
    assert.equal((await adapter.importResource(file, 'chat', 'overwrite', { targetName: 'b.png' })).status, 'created')
    assert.equal(calls[0].body.get('avatar_url'), 'b.png')
    assert.equal(await calls[0].body.get('avatar').text(), raw)
    assert.equal(calls[0].body.get('file_type'), 'jsonl')
    await assert.rejects(adapter.importResource(file, 'chat', 'copy', { targetName: '同名' }), /接收角色不存在/)
    await assert.rejects(adapter.importResource(file, 'chat', 'copy', { targetName: '../b.png' }), /接收角色不存在/)
    assert.equal(calls.length, 1)
    globalThis.fetch = async () => Response.json({ error: true })
    await assert.rejects(adapter.importResource(file, 'chat', 'copy', { targetName: 'b.png' }), /未确认保存/)
  } finally { Object.assign(globalThis, previous) }
})

test('chat companion rules bind to the exact avatar even when two characters share a name', async () => {
  const previous = globalThis.window
  let updated
  const context = {
    characters: [{ name: '同名', avatar: 'a.png' }, { name: '同名', avatar: 'b.png', data: { extensions: { regex_scripts: [{ id: 'original', disabled: false }] } } }],
    writeExtensionField: async (index, field, rules) => { updated = { index, field, rules } },
  }
  globalThis.window = { SillyTavern: { getContext: () => context } }
  try {
    await new TavernAdapter().importResource(new File([JSON.stringify({ sourceAvatar: 'b.png', chatCompanion: true, sourceName: '同名', scoped: [{ id: 'rule', scriptName: '状态', findRegex: '/x/g', replaceString: 'y', disabled: false }] })], 'rules.json'), 'regexCharacter', 'overwrite', { targetName: 'b.png' })
    assert.equal(updated.index, 1)
    assert.equal(updated.rules.length, 2)
    assert.equal(updated.rules[0].id, 'original')
    assert.equal(updated.rules[0].disabled, false)
    assert.equal(updated.rules[1].disabled, true)
    assert.equal(context.characters[0].data, undefined)
  } finally { globalThis.window = previous }
})
