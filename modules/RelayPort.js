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
  constructor(context, session, relayBase = '/api/plugins/srl-bridge/') {
    this.context = context
    this.session = session
    this.relayBase = new URL(relayBase, window.location.origin).href
    this.remote = new URL(this.relayBase).origin !== window.location.origin
    this.onmessage = null
    this.closed = false
    this.sendChain = Promise.resolve()
    this.abort = new AbortController()
    this.acknowledgements = []
    this.delivered = new Set()
    this.retrying = 0
    this.processingPoll = false
    this.chunkAcknowledgements = []
    this.ackFlush = null
  }

  start() {
    void this.poll()
  }

  postMessage(message) {
    if (this.closed) return Promise.reject(new Error('设备码中继已经关闭'))
    // Chunks are validated/stored before this ACK. Flush one bounded window
    // together rather than holding the receive loop behind each HTTP response.
    if (this.processingPoll && message?.type === 'file-chunk-ack') {
      this.chunkAcknowledgements.push(message)
      return Promise.resolve()
    }
    const task = this.sendChain.then(() =>
      this.flushChunkAcknowledgements().then(() => this.request('messages', {
        code: this.session.code,
        token: this.session.controllerToken,
        message: encode(message),
        ...(this.session.reliableDelivery ? { messageId: crypto.randomUUID() } : {}),
      })),
    )
    // Return the failure to this caller without poisoning subsequent operations.
    this.sendChain = task.catch(() => {})
    return task
  }

  flushChunkAcknowledgements() {
    if (this.ackFlush) return this.ackFlush
    const run = async () => {
      while (this.chunkAcknowledgements.length && !this.closed) {
        const batch = this.chunkAcknowledgements.splice(0, 6)
        await Promise.all(batch.map((message) => this.postFileChunk(message)))
      }
    }
    const task = run().finally(() => { this.ackFlush = null })
    this.ackFlush = task
    return task
  }

  postFileChunk(message) {
    if (this.closed) return Promise.reject(new Error('设备码中继已经关闭'))
    return this.request('messages', {
      code: this.session.code,
      token: this.session.controllerToken,
      message: encode(message),
      ...(message?.type === 'file-chunk-ack' && this.acknowledgements.length
        ? { acknowledgements: [...this.acknowledgements] }
        : {}),
      ...(this.session.reliableDelivery ? { messageId: crypto.randomUUID() } : {}),
    }).catch((error) => {
      if (!this.closed) this.onerror?.(error)
      throw error
    })
  }

  async poll() {
    while (!this.closed) {
      try {
        const result = await this.request('poll', {
          code: this.session.code,
          token: this.session.controllerToken,
          reliableDelivery: this.session.reliableDelivery === true,
          acknowledgements: this.acknowledgements,
        })
        if (result?.closed) throw new Error('设备码中继已经关闭')
        if (this.closed) return
        this.acknowledgements = []
        this.processingPoll = true
        try {
        for (const [index, message] of (result?.messages ?? []).entries()) {
          const id = result?.deliveryIds?.[index]
          if (!id || !this.delivered.has(id)) await this.onmessage?.({ data: decode(message) })
          if (id) {
            this.delivered.add(id)
            this.acknowledgements.push(id)
            if (this.delivered.size > 4096) this.delivered.delete(this.delivered.values().next().value)
          }
        }
        } finally { this.processingPoll = false }
        await this.flushChunkAcknowledgements()
      } catch (error) {
        if (!this.closed) this.onerror?.(error)
        this.closed = true
      }
    }
  }

  async request(path, body, keepalive = false) {
    let recovering = false
    try {
      for (let attempt = 0; ; attempt++) {
        try { return await this.requestOnce(path, body, keepalive) }
        catch (error) {
          const temporary = error.status === undefined ? error instanceof TypeError : [408, 429, 500, 502, 503, 504].includes(error.status)
          if (keepalive || this.closed || !this.session.reliableDelivery || !temporary || attempt >= 3) throw error
          if (!recovering) { recovering = true; this.retrying++; this.onrecovery?.(true) }
          await new Promise((resolve, reject) => {
            const aborted = () => { clearTimeout(timer); reject(new DOMException('已断开', 'AbortError')) }
            const timer = setTimeout(() => { this.abort.signal.removeEventListener('abort', aborted); resolve() }, [500, 1500, 3000][attempt])
            this.abort.signal.addEventListener('abort', aborted, { once: true })
          })
        }
      }
    } finally {
      if (recovering && --this.retrying === 0 && !this.closed) this.onrecovery?.(false)
    }
  }

  async requestOnce(path, body, keepalive = false) {
    const response = await fetch(new URL(path, this.relayBase), {
      method: 'POST',
      headers: this.remote
        ? { 'Content-Type': 'application/json' }
        : this.context.getRequestHeaders(),
      body: JSON.stringify(body),
      cache: 'no-store',
      mode: this.remote ? 'cors' : 'same-origin',
      keepalive,
      ...(keepalive ? {} : { signal: this.abort.signal }),
    })
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}))
      throw Object.assign(new Error(detail.error || detail.message || `设备码中继请求失败（HTTP ${response.status}）`), { status: response.status })
    }
    return response.status === 204 ? undefined : response.json()
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.abort.abort()
    this.chunkAcknowledgements.length = 0
    const body = {
      code: this.session.code,
      token: this.session.controllerToken,
    }
    // pagehide may end the document before a normal fetch is dispatched.
    if (!this.remote && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon(
        new URL('close', this.relayBase),
        new Blob([JSON.stringify(body)], { type: 'application/json' }),
      )
    }
    void this.request('close', body, true).catch(() => {})
  }
}
