export const BRIDGE_PROTOCOL = 'srl-tavern-bridge'
export const BRIDGE_VERSION = 2
export const CHUNK_SIZE = 256 * 1024
export const MAX_FILE_SIZE = 256 * 1024 * 1024

export const RESOURCE_KINDS = Object.freeze({
  CHARACTER: 'character',
  WORLD_BOOK: 'worldBook',
  PRESET: 'preset',
  REGEX_GLOBAL: 'regexGlobal',
  REGEX_CHARACTER: 'regexCharacter',
  REGEX_PRESET: 'regexPreset',
  QUICK_REPLY: 'quickReply',
  THEME: 'theme',
})

export function createId(prefix = 'message') {
  return `${prefix}-${crypto.randomUUID()}`
}

export function isBridgeEnvelope(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    value.protocol === BRIDGE_PROTOCOL &&
    value.version === BRIDGE_VERSION &&
    typeof value.type === 'string',
  )
}

export function envelope(type, payload = {}) {
  return {
    protocol: BRIDGE_PROTOCOL,
    version: BRIDGE_VERSION,
    type,
    ...payload,
  }
}

export async function sha256(blob) {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('')
}

export function safeFileName(value, fallback = 'resource') {
  const cleaned = String(value ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .trim()
    .slice(0, 120)
  return cleaned || fallback
}

export function uniqueName(baseName, existingNames) {
  const existing = new Set(Array.from(existingNames, (name) => String(name).toLocaleLowerCase()))
  if (!existing.has(baseName.toLocaleLowerCase())) return baseName
  let index = 2
  while (existing.has(`${baseName} (SRL ${index})`.toLocaleLowerCase())) index += 1
  return `${baseName} (SRL ${index})`
}
