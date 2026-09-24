// Wire contract v1. Keep byte-identical to the extension's modules/ParcelTransfer.js.
const CHUNK = 256 * 1024
const LIMIT = 16 * 1024 * 1024
const enc = new TextEncoder()
const kinds = new Set([
  'chat',
  'character',
  'worldBook',
  'preset',
  'theme',
  'quickReply',
  'userAvatar',
  'userPersona',
  'regexGlobal',
  'regexCharacter',
  'regexPreset',
  'scriptGlobal',
  'scriptCharacter',
  'scriptPreset',
])
const hex = (bytes) => [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
async function hash(blob) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())))
}
function endpoint(base, action) {
  const url = new URL(base)
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  )
    throw new Error('加密暂存需要 HTTPS 资源库地址')
  return new URL(`/api/bridge/parcels/${action}`, url.origin)
}
function checkCancelled(signal) {
  if (signal?.aborted) throw new DOMException('已取消传输，可以重新操作', 'AbortError')
}
async function request(base, action, body, headers, signal, fetcher = fetch) {
  for (let attempt = 0; ; attempt++) {
    checkCancelled(signal)
    const abort = new AbortController()
    const cancel = () => abort.abort()
    signal?.addEventListener('abort', cancel, { once: true })
    // A stalled fetch/body used to leave both panels disabled indefinitely.
    const timer = setTimeout(() => abort.abort(), 45_000)
    try {
      const response = await fetcher(endpoint(base, action), {
        method: 'POST',
        cache: 'no-store',
        credentials: 'omit',
        headers: headers || { 'content-type': 'application/json' },
        body: headers ? body : JSON.stringify(body),
        signal: abort.signal,
      })
      const bytes = await response.arrayBuffer()
      if (bytes.byteLength > CHUNK + 1024) throw new Error('暂存服务响应过大，已停止领取')
      if (!response.ok) {
        let detail = {}
        try {
          detail = JSON.parse(new TextDecoder().decode(bytes))
        } catch {
          /* HTTP status remains useful */
        }
        throw Object.assign(
          new Error(detail.message || detail.error || `暂存请求失败（HTTP ${response.status}）`),
          { status: response.status },
        )
      }
      return response.status === 204 ? new Response(null, { status: 204 }) : new Response(bytes)
    } catch (error) {
      checkCancelled(signal)
      if (abort.signal.aborted)
        throw new Error('网络长时间没有响应，已停止；请检查网络后重试', { cause: error })
      const retryable =
        error instanceof TypeError || [408, 429, 500, 502, 503, 504].includes(error.status)
      if (action === 'create' || !retryable || attempt >= 2) throw error
      await new Promise((resolve) => setTimeout(resolve, attempt ? 1500 : 500))
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
    }
  }
}
async function parallelChunks(count, signal, task) {
  const abort = new AbortController()
  const cancel = () => abort.abort()
  signal?.addEventListener('abort', cancel, { once: true })
  let next = 0
  let failure
  try {
    checkCancelled(signal)
    await Promise.all(
      Array.from({ length: Math.min(4, count) }, async () => {
        try {
          while (next < count) {
            checkCancelled(abort.signal)
            await task(next++, abort.signal)
          }
        } catch (error) {
          failure ||= error
          abort.abort()
        }
      }),
    )
    checkCancelled(signal)
    if (failure) throw failure
  } finally {
    signal?.removeEventListener('abort', cancel)
  }
}
function ticketParts(ticket) {
  const match = /^SRL1\.([a-f0-9]{64})\.([A-Za-z0-9_-]{43})$/.exec(ticket.trim())
  if (!match) throw new Error('请粘贴完整的 SRL1 提取口令；它与八位设备码不同')
  const bytes = Uint8Array.from(atob(match[2].replace(/-/g, '+').replace(/_/g, '/') + '='), (c) =>
    c.charCodeAt(0),
  )
  return { code: match[1], key: bytes }
}

export async function createParcel(
  base,
  files,
  progress = () => {},
  { signal, fetcher = fetch } = {},
) {
  checkCancelled(signal)
  if (!files.length || files.length > 100) throw new Error('每次请选择 1～100 项资源')
  let total = 0
  const manifest = []
  for (const item of files) {
    checkCancelled(signal)
    total += item.file.size
    if (total > LIMIT) throw new Error('加密暂存每次最多 16 MiB，请分批发送或使用实时互传')
    if (!kinds.has(item.kind)) throw new Error('不支持暂存此类资源')
    manifest.push({
      name: item.file.name,
      displayName: item.displayName,
      kind: item.kind,
      targetName: item.targetName,
      type: item.file.type,
      size: item.file.size,
      sha256: await hash(item.file),
    })
  }
  const header = enc.encode(JSON.stringify({ version: 1, files: manifest }))
  const prefix = new Uint8Array(4)
  new DataView(prefix.buffer).setUint32(0, header.length)
  const blob = new Blob([prefix, header, ...files.map((item) => item.file)])
  if (blob.size > LIMIT) throw new Error('暂存内容连同目录超过 16 MiB，请减少选择')
  const chunks = Math.ceil(blob.size / CHUNK)
  const keyBytes = crypto.getRandomValues(new Uint8Array(32))
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt'])
  const created = await (
    await request(
      base,
      'create',
      { chunks, size: blob.size + chunks * 28 },
      undefined,
      signal,
      fetcher,
    )
  ).json()
  if (!/^[a-f0-9]{64}$/.test(created.code)) throw new Error('暂存服务返回了无效口令')
  const code = created.code
  try {
    let completed = 0
    progress(`正在加密暂存 0 / ${chunks}，请保持前台`)
    await parallelChunks(chunks, signal, async (index, chunkSignal) => {
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: enc.encode(`${code}/${index}/${chunks}`) },
        key,
        await blob.slice(index * CHUNK, (index + 1) * CHUNK).arrayBuffer(),
      )
      await request(
        base,
        'upload',
        new Blob([iv, encrypted]),
        {
          'content-type': 'application/octet-stream',
          'x-srl-parcel-code': code,
          'x-srl-parcel-index': String(index),
        },
        chunkSignal,
        fetcher,
      )
      progress(`正在加密暂存 ${++completed} / ${chunks}，请保持前台`)
    })
    await request(base, 'seal', { code }, undefined, signal, fetcher)
    const encodedKey = btoa(String.fromCharCode(...keyBytes))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '')
    progress('已加密暂存，可以切换到另一端领取；30 分钟内有效')
    return { ticket: `SRL1.${code}.${encodedKey}`, expiresAt: created.expiresAt }
  } catch (error) {
    // Do not delay cancellation behind a second network request; incomplete parcels expire.
    void request(base, 'remove', { code }, undefined, undefined, fetcher).catch(() => {})
    throw error
  }
}

export async function readParcel(
  base,
  ticket,
  progress = () => {},
  { signal, fetcher = fetch } = {},
) {
  checkCancelled(signal)
  const { code, key: bytes } = ticketParts(ticket)
  const meta = await (await request(base, 'info', { code }, undefined, signal, fetcher)).json()
  if (
    !Number.isInteger(meta.chunks) ||
    meta.chunks < 1 ||
    meta.chunks > 65 ||
    !Number.isInteger(meta.size) ||
    meta.size > 17 * 1024 * 1024
  )
    throw new Error('暂存目录无效')
  const key = await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['decrypt'])
  const decrypted = []
  let total = 0
  let received = 0
  let completed = 0
  progress(`正在领取并校验 0 / ${meta.chunks}，请保持前台`)
  await parallelChunks(meta.chunks, signal, async (index, chunkSignal) => {
    const response = await request(
      base,
      'download',
      { code, index },
      undefined,
      chunkSignal,
      fetcher,
    )
    const buffer = new Uint8Array(await response.arrayBuffer())
    if (buffer.length < 28 || buffer.length > CHUNK + 28) throw new Error('暂存分块大小无效')
    let plain
    try {
      plain = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: buffer.slice(0, 12),
          additionalData: enc.encode(`${code}/${index}/${meta.chunks}`),
        },
        key,
        buffer.slice(12),
      )
    } catch {
      throw new Error('提取口令错误或暂存数据损坏，未导入任何文件')
    }
    received += buffer.length
    total += plain.byteLength
    if (total > LIMIT) throw new Error('暂存解密后超过 16 MiB')
    decrypted[index] = plain
    progress(`正在领取并校验 ${++completed} / ${meta.chunks}，请保持前台`)
  })
  if (received !== meta.size) throw new Error('暂存数据不完整')
  const blob = new Blob(decrypted)
  const size = new DataView(await blob.slice(0, 4).arrayBuffer()).getUint32(0)
  if (size < 1 || size > 256 * 1024 || size + 4 > blob.size) throw new Error('暂存文件目录损坏')
  const manifest = JSON.parse(await blob.slice(4, 4 + size).text())
  if (
    manifest.version !== 1 ||
    !Array.isArray(manifest.files) ||
    !manifest.files.length ||
    manifest.files.length > 100
  )
    throw new Error('不支持的暂存格式')
  const files = []
  let offset = 4 + size
  for (const [index, item] of manifest.files.entries()) {
    checkCancelled(signal)
    if (
      !kinds.has(item.kind) ||
      typeof item.name !== 'string' ||
      !item.name ||
      item.name.length > 200 ||
      /[/\\]/.test(item.name) ||
      [...item.name].some((char) => char.charCodeAt(0) < 32) ||
      !Number.isInteger(item.size) ||
      item.size < 0 ||
      offset + item.size > blob.size ||
      typeof item.type !== 'string' ||
      typeof item.displayName !== 'string' ||
      (item.targetName !== undefined && typeof item.targetName !== 'string')
    )
      throw new Error('暂存资源条目无效')
    const file = new File([blob.slice(offset, offset + item.size)], item.name, { type: item.type })
    if ((await hash(file)) !== item.sha256) throw new Error('暂存文件完整性校验失败')
    files.push({
      file,
      kind: item.kind,
      displayName: item.displayName,
      targetName: item.targetName,
      operationId: `${code}-${index}`,
    })
    offset += item.size
  }
  if (offset !== blob.size) throw new Error('暂存包含未声明内容')
  progress(`已领取 ${files.length} 项，等待确认导入`)
  return files
}

export async function removeParcel(base, ticket, { signal, fetcher = fetch } = {}) {
  const { code } = ticketParts(ticket)
  await request(base, 'remove', { code }, undefined, signal, fetcher)
}
