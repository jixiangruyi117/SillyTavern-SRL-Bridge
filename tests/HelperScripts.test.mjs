import test from 'node:test'
import assert from 'node:assert/strict'

import {
  countHelperScripts,
  normalizeHelperScriptTrees,
  readHelperCharacterScripts,
  readHelperGlobalScripts,
  readHelperPresetScripts,
  sanitizeImportedHelperTree,
} from '../modules/TavernAdapter.js'

test('读取三个作用域的酒馆助手脚本（含旧键回退）', () => {
  const tree = { type: 'script', id: 'a', name: '脚本', content: '1', enabled: true }

  assert.deepEqual(
    readHelperGlobalScripts({ tavern_helper: { script: { scripts: [tree] } } }),
    [tree],
  )
  assert.deepEqual(readHelperGlobalScripts({ TavernHelper: { script: { scripts: [tree] } } }), [
    tree,
  ])
  assert.deepEqual(readHelperGlobalScripts({}), [])

  assert.deepEqual(
    readHelperCharacterScripts({ data: { extensions: { tavern_helper: { scripts: [tree] } } } }),
    [tree],
  )
  assert.deepEqual(
    readHelperCharacterScripts({ data: { extensions: { TavernHelper_scripts: [tree] } } }),
    [tree],
  )

  assert.deepEqual(readHelperPresetScripts({ extensions: { tavern_helper: { scripts: [tree] } } }), [
    tree,
  ])
  assert.deepEqual(readHelperPresetScripts(undefined), [])
})

test('normalizeHelperScriptTrees 接受数组、单树、scripts 包裹与旧版纯脚本', () => {
  const script = { type: 'script', name: 'a', content: 'x' }
  const folder = { type: 'folder', name: 'f', scripts: [script] }

  assert.equal(normalizeHelperScriptTrees([script, folder]).length, 2)
  assert.equal(normalizeHelperScriptTrees(script).length, 1)
  assert.equal(normalizeHelperScriptTrees({ scripts: [script], sourceName: '卡' }).length, 1)

  const legacy = normalizeHelperScriptTrees({ name: '旧脚本', content: 'code' })
  assert.equal(legacy.length, 1)
  assert.equal(legacy[0].type, 'script')

  // 无 content 的未知对象被剔除
  assert.equal(normalizeHelperScriptTrees({ name: '空对象' }).length, 0)
})

test('sanitizeImportedHelperTree 换新 id 并整树停用', () => {
  const folder = {
    type: 'folder',
    id: 'old-folder',
    name: 'f',
    enabled: true,
    scripts: [{ type: 'script', id: 'old-script', name: 's', content: 'x', enabled: true }],
  }
  const next = sanitizeImportedHelperTree(folder)
  assert.notEqual(next.id, 'old-folder')
  assert.equal(next.enabled, false)
  assert.notEqual(next.scripts[0].id, 'old-script')
  assert.equal(next.scripts[0].enabled, false)
  // 原对象不被修改
  assert.equal(folder.enabled, true)
  assert.equal(folder.scripts[0].id, 'old-script')
})

test('countHelperScripts 统计文件夹内脚本数量', () => {
  assert.equal(
    countHelperScripts([
      { type: 'script', content: 'a' },
      { type: 'folder', scripts: [{}, {}] },
    ]),
    3,
  )
})
