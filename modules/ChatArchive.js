/* global TextEncoder, TextDecoder, File */
// Wire contract v1. Keep identical to Bridge's modules/ChatArchive.js.
// Blob framing preserves original PNG/JSONL bytes without base64 or a whole-file buffer.
const MAGIC = 'SRLCHAT1'
const HEADER_LIMIT = 16 * 1024
export const REGEX_LIMIT = 2 * 1024 * 1024
const MAX_ARCHIVE_SIZE = 256 * 1024 * 1024
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

function fileName(value, extension) {
  return (
    typeof value === 'string' &&
    value.length <= 255 &&
    // eslint-disable-next-line no-control-regex -- wire filenames must reject control bytes
    !/[\\/\u0000-\u001f]/u.test(value) &&
    value.toLowerCase().endsWith(extension)
  )
}
function validate(meta) {
  if (
    !meta ||
    meta.format !== 'srl-chat-archive' ||
    meta.version !== 1 ||
    !fileName(meta.avatar, '.png') ||
    !fileName(meta.chatName, '.jsonl') ||
    !Number.isSafeInteger(meta.cardBytes) ||
    meta.cardBytes < 1 ||
    !Number.isSafeInteger(meta.chatBytes) ||
    meta.chatBytes < 1 ||
    (meta.regexBytes !== undefined &&
      (!Number.isSafeInteger(meta.regexBytes) ||
        meta.regexBytes < 0 ||
        meta.regexBytes > REGEX_LIMIT))
  )
    throw new Error('聊天传输包信息无效或超过大小限制')
}
export function createChatArchive(card, chat, avatar, displayRules = [], regexContext = {}) {
  if (!Array.isArray(displayRules) || displayRules.length > 128)
    throw new Error('聊天显示正则数量无效')
  const presetRules = regexContext.presetRules ?? []
  if (!Array.isArray(presetRules) || presetRules.length > 128)
    throw new Error('预设显示正则数量无效')
  const regex =
    displayRules.length || presetRules.length
      ? encoder.encode(JSON.stringify({ global: displayRules, preset: presetRules }))
      : new Uint8Array()
  const meta = {
    format: 'srl-chat-archive',
    version: 1,
    avatar,
    chatName: chat.name,
    cardBytes: card.size,
    chatBytes: chat.size,
    regexBytes: regex.length,
    regexContext: {
      presetName:
        typeof regexContext.presetName === 'string' ? regexContext.presetName.slice(0, 255) : '',
      presetEnabled: regexContext.presetEnabled !== false,
      characterEnabled: regexContext.characterEnabled !== false,
    },
  }
  validate(meta)
  const header = encoder.encode(JSON.stringify(meta))
  if (12 + header.length + card.size + chat.size + regex.length > MAX_ARCHIVE_SIZE)
    throw new Error('聊天归档超过单文件 256 MiB 传输上限')
  const prefix = new Uint8Array(12)
  prefix.set(encoder.encode(MAGIC))
  new DataView(prefix.buffer).setUint32(8, header.length)
  return new File(
    [prefix, header, card, chat, regex],
    `${chat.name.slice(0, -6).slice(0, 120)}.srlchat`,
    {
      type: 'application/x-srl-chat',
    },
  )
}
export async function readChatArchive(file) {
  if (file.size < 13 || file.size > MAX_ARCHIVE_SIZE) throw new Error('聊天传输包大小无效')
  const prefix = await file.slice(0, 12).arrayBuffer()
  if (decoder.decode(new Uint8Array(prefix, 0, 8)) !== MAGIC)
    throw new Error('不是受支持的聊天传输包')
  const length = new DataView(prefix).getUint32(8)
  if (length < 1 || length > HEADER_LIMIT || 12 + length >= file.size)
    throw new Error('聊天传输包头损坏')
  const meta = JSON.parse(await file.slice(12, 12 + length).text())
  validate(meta)
  if (12 + length + meta.cardBytes + meta.chatBytes + (meta.regexBytes || 0) !== file.size)
    throw new Error('聊天传输包不完整')
  const split = 12 + length + meta.cardBytes
  const end = split + meta.chatBytes
  const bundle = meta.regexBytes ? JSON.parse(await file.slice(end).text()) : {}
  const displayRules = Array.isArray(bundle) ? bundle : (bundle.global ?? [])
  const presetRules = Array.isArray(bundle) ? [] : (bundle.preset ?? [])
  if (
    !Array.isArray(displayRules) ||
    displayRules.length > 128 ||
    !Array.isArray(presetRules) ||
    presetRules.length > 128 ||
    [...displayRules, ...presetRules].some(
      (rule) =>
        !rule ||
        typeof rule !== 'object' ||
        typeof rule.findRegex !== 'string' ||
        typeof rule.replaceString !== 'string' ||
        rule.markdownOnly !== true,
    )
  )
    throw new Error('聊天显示正则内容无效')
  return {
    avatar: meta.avatar,
    card: new File([file.slice(12 + length, split)], meta.avatar, { type: 'image/png' }),
    chat: new File([file.slice(split, end)], meta.chatName, { type: 'application/x-ndjson' }),
    displayRules,
    presetRules,
    hasRegexSnapshot: meta.regexBytes !== undefined,
    regexContext: {
      presetName:
        typeof meta.regexContext?.presetName === 'string'
          ? meta.regexContext.presetName.slice(0, 255)
          : '',
      presetEnabled: meta.regexContext?.presetEnabled !== false,
      characterEnabled: meta.regexContext?.characterEnabled !== false,
    },
  }
}
