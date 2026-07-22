function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

function base64ToBuffer(value) {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes.buffer
}

function encode(value) {
  if (value instanceof ArrayBuffer) return { __srlBuffer: bytesToBase64(value) }
  if (Array.isArray(value)) return value.map(encode)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)]))
  }
  return value
}

function decode(value) {
  if (value && typeof value === 'object' && typeof value.__srlBuffer === 'string') {
    return base64ToBuffer(value.__srlBuffer)
  }
  if (Array.isArray(value)) return value.map(decode)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)]))
  }
  return value
}

export class RelayPort {
  constructor(context, session) {
    this.context = context
    this.session = session
    this.onmessage = null
    this.closed = false
    this.sendChain = Promise.resolve()
  }

  start() {
    void this.poll()
  }

  postMessage(message) {
    if (this.closed) return Promise.reject(new Error('设备码中继已经关闭'))
    this.sendChain = this.sendChain.then(() =>
      this.request('messages', {
        code: this.session.code,
        token: this.session.controllerToken,
        message: encode(message),
      }),
    )
    return this.sendChain
  }

  async poll() {
    while (!this.closed) {
      try {
        const result = await this.request('poll', {
          code: this.session.code,
          token: this.session.controllerToken,
        })
        if (result?.closed) throw new Error('设备码中继已经关闭')
        for (const message of result?.messages ?? []) this.onmessage?.({ data: decode(message) })
      } catch (error) {
        if (!this.closed) this.onerror?.(error)
        this.closed = true
      }
    }
  }

  async request(path, body) {
    const response = await fetch(`/api/plugins/srl-bridge/${path}`, {
      method: 'POST',
      headers: this.context.getRequestHeaders(),
      body: JSON.stringify(body),
      cache: 'no-store',
    })
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}))
      throw new Error(detail.error || `设备码中继请求失败（HTTP ${response.status}）`)
    }
    return response.status === 204 ? undefined : response.json()
  }

  close() {
    if (this.closed) return
    this.closed = true
    void this.request('close', {
      code: this.session.code,
      token: this.session.controllerToken,
    }).catch(() => {})
  }
}
