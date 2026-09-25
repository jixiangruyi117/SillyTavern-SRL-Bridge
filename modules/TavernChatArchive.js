import { createChatArchive } from './ChatArchive.js?v=0.3.37'
import { MAX_FILE_SIZE } from './Protocol.js?v=0.3.37'

function safeName(value) {
  return typeof value === 'string' && value.length <= 255 && !/[\\/\u0000-\u001f]/u.test(value)
}
async function chatNames(context, avatar, includeSizes = false) {
  const response = await fetch('/api/characters/chats', {
    method: 'POST', headers: context.getRequestHeaders(),
    body: JSON.stringify({ avatar_url: avatar, simple: !includeSizes }),
  })
  if (!response.ok) throw new Error(`读取 ${avatar} 的聊天目录失败（HTTP ${response.status}）`)
  const data = await response.json()
  // SillyTavern returns error:true when this character has no chat directory yet.
  if (data?.error === true) return []
  if (!data || typeof data !== 'object') throw new Error('酒馆返回了无效的聊天目录')
  return Object.values(data)
    .filter((row) => safeName(row?.file_name) && row.file_name.endsWith('.jsonl'))
    .map((row) => ({ name: row.file_name,
      sizeLabel: typeof row.file_size === 'string' && /^\d+(?:\.\d+)?\s*(?:[KMGT]?B|Bytes)$/i.test(row.file_size.trim())
        ? row.file_size.trim() : undefined }))
}
export async function listChatResources(context) {
  const characters = context.characters.filter((card) => safeName(card.avatar) && card.avatar.endsWith('.png'))
  const items = []
  // Explicit inventory only. The host's normal chat index supplies rounded sizes;
  // it may scan files server-side, but no chat body is transferred or changed here.
  for (let offset = 0; offset < characters.length; offset += 4) {
    const groups = await Promise.all(characters.slice(offset, offset + 4).map(async (card) =>
      (await chatNames(context, card.avatar, true)).map(({ name: file, sizeLabel }) => ({
        id: `chat:${JSON.stringify([card.avatar, file])}`, kind: 'chat',
        name: file.slice(0, -6), fileName: `${file.slice(0, -6)}.srlchat`,
        ...(sizeLabel ? { sizeLabel } : {}),
        detail: `聊天记录 · ${card.name || card.avatar} · ${card.avatar}（随附角色卡）`,
      }))))
    items.push(...groups.flat())
  }
  return items
}
export async function exportChatArchive(context, item, exportCard) {
  let identity
  try { identity = JSON.parse(item.id.slice(5)) } catch { throw new Error('聊天标识无效') }
  const [avatar, name] = Array.isArray(identity) ? identity : []
  if (!safeName(avatar) || !safeName(name) ||
      !context.characters.some((card) => card.avatar === avatar) ||
      !(await chatNames(context, avatar)).some((file) => file.name === name))
    throw new Error('聊天或所属角色已不存在，请重新读取目录')
  const response = await fetch('/api/chats/export', {
    method: 'POST', headers: context.getRequestHeaders(),
    body: JSON.stringify({ is_group: false, avatar_url: avatar, file: name,
      exportfilename: name, format: 'jsonl' }),
  })
  if (!response.ok) throw new Error(`导出聊天失败（HTTP ${response.status}）`)
  // Official endpoint wraps raw JSONL in JSON. Bound the body before decoding it.
  const reader = response.body.getReader(); const parts = []; let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > MAX_FILE_SIZE * 2 + 4096) { await reader.cancel(); throw new Error('聊天导出响应超过单文件最大传输容量') }
      parts.push(value)
    }
  } finally { reader.releaseLock() }
  const data = JSON.parse(await new Blob(parts).text())
  if (typeof data.result !== 'string' || !data.result.trim()) throw new Error('酒馆没有返回有效聊天原件')
  const chat = new File([data.result], name, { type: 'application/x-ndjson' })
  const card = await exportCard({ id: `character:${avatar}`, kind: 'character', name: avatar })
  // ST displays global rules before scoped card rules. Keep the exported originals untouched.
  const displayRules = (Array.isArray(context.extensionSettings?.regex) ? context.extensionSettings.regex : [])
    .filter(rule => rule && rule.markdownOnly === true)
  const manager = await context.getPresetManager?.()
  const presetName = await manager?.getSelectedPresetName?.() || ''
  const preset = await manager?.readPresetExtensionField?.({ path: 'regex_scripts' })
  const presetRules = (Array.isArray(preset) ? preset : []).filter(rule => rule?.markdownOnly === true)
  const presetAllowed = context.extensionSettings?.preset_allowed_regex?.[manager?.apiId]
  const characterAllowed = context.extensionSettings?.character_allowed_regex
  return createChatArchive(card, chat, avatar, displayRules, {
    presetRules, presetName,
    presetEnabled: Array.isArray(presetAllowed) && presetAllowed.includes(presetName),
    characterEnabled: Array.isArray(characterAllowed) && characterAllowed.includes(avatar),
  })
}

/** Use the host's JSONL importer and an explicitly confirmed avatar, never live-chat save. */
export async function importChatRecord(context, file, avatar) {
  if (!safeName(avatar) || !avatar.endsWith('.png') ||
      !context.characters.some(card => card.avatar === avatar))
    throw new Error('接收角色不存在，请刷新资源库目录并重新确认目标')
  if (!/\.jsonl$/i.test(file.name) || file.size < 1 || file.size > MAX_FILE_SIZE)
    throw new Error('聊天回传需要有效的 JSONL 原件（最大 256 MB）')
  // ST JSON.parse(header) does not accept a UTF-8 BOM; remove only those three bytes.
  const prefix = new Uint8Array(await file.slice(0, 3).arrayBuffer())
  const body = prefix[0] === 239 && prefix[1] === 187 && prefix[2] === 191 ? file.slice(3) : file
  const form = new FormData()
  form.append('avatar', body, file.name)
  form.append('avatar_url', avatar)
  form.append('file_type', 'jsonl')
  form.append('user_name', context.name1 || 'User')
  // Host import names include character_name. Unique suffix prevents same-tick overwrites.
  form.append('character_name', `${file.name.slice(0, -6).slice(0, 120)} SRL-${crypto.randomUUID().slice(0, 8)}`)
  const response = await fetch('/api/chats/import', {
    method: 'POST', headers: context.getRequestHeaders({ omitContentType: true }), body: form,
  })
  if (!response.ok) throw new Error(`导入聊天失败（HTTP ${response.status}）`)
  const result = await response.json()
  if (result.error || !result.res || !Array.isArray(result.fileNames) || !result.fileNames.length)
    throw new Error('酒馆未确认保存聊天，资源库原件仍保留')
  return { status: 'created', name: result.fileNames.join('、') }
}
