import {
  BRIDGE_PROTOCOL,
  BRIDGE_VERSION,
  CHUNK_SIZE,
  MAX_FILE_SIZE,
  createId,
  envelope,
  isBridgeEnvelope,
  sha256,
} from './Protocol.js'

export class BridgeController extends EventTarget {
  constructor(adapter) {
    super()
    this.adapter = adapter
    this.popup = null
    this.port = null
    this.channel = ''
    this.pairCode = ''
    this.expectedSrlOrigin = ''
    this.incoming = new Map()
    this.messageChain = Promise.resolve()
    this.handleWindowMessage = this.handleWindowMessage.bind(this)
    window.addEventListener('message', this.handleWindowMessage)
  }

  open(srlUrl) {
    const target = new URL(srlUrl)
    if (!['http:', 'https:'].includes(target.protocol)) throw new Error('SRL 地址必须使用 HTTP 或 HTTPS')
    this.disconnect('正在建立新连接')
    this.channel = crypto.randomUUID()
    this.pairCode = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0')
    this.expectedSrlOrigin = target.origin
    target.searchParams.set('srlBridge', this.channel)
    target.searchParams.set('pair', this.pairCode)
    target.searchParams.set('stOrigin', window.location.origin)
    const relay = new URL('../bridge.html', import.meta.url)
    relay.searchParams.set('target', target.href)
    relay.searchParams.set('srlOrigin', target.origin)
    relay.searchParams.set('channel', this.channel)
    this.popup = window.open(relay.href, 'srl-tavern-bridge')
    if (!this.popup) throw new Error('浏览器阻止了新窗口，请允许酒馆打开 SRL')
    this.emitState('waiting', '等待 SRL 确认配对')
    return this.pairCode
  }

  handleWindowMessage(event) {
    if (event.origin !== window.location.origin || event.source !== this.popup) return
    const message = event.data
    if (
      !isBridgeEnvelope(message) ||
      message.type !== 'srl-hello' ||
      message.channel !== this.channel ||
      message.forwardedOrigin !== this.expectedSrlOrigin
    )
      return
    this.port?.close()
    const pair = new MessageChannel()
    this.port = pair.port1
    this.port.onmessage = (portEvent) => {
      this.messageChain = this.messageChain
        .then(() => this.handlePortMessage(portEvent.data))
        .catch((error) => this.emitLog(error instanceof Error ? error.message : '通信处理失败', 'error'))
    }
    this.port.start()
    event.source.postMessage(
      envelope('st-port', {
        channel: this.channel,
        pairCode: this.pairCode,
        capabilities: ['character', 'worldBook', 'preset', 'regex', 'quickReply', 'theme'],
        tavernVersion: window.SillyTavern?.getContext?.().version || '1.18+',
      }),
      window.location.origin,
      [pair.port2],
    )
    this.emitState('pairing', '请在 SRL 核对配对码')
  }

  async handlePortMessage(message) {
    if (!isBridgeEnvelope(message)) return
    try {
      if (message.type === 'srl-accept') {
        if (message.pairCode !== this.pairCode) throw new Error('配对码不一致')
        this.send('st-ready', {
          capabilities: ['character', 'worldBook', 'preset', 'regex', 'quickReply', 'theme'],
        })
        this.emitState('connected', '已连接 SRL')
      } else if (message.type === 'list-request') {
        this.send('list-response', { requestId: message.requestId, items: await this.adapter.listResources() })
      } else if (message.type === 'pull-request') {
        await this.sendResources(message.requestId, message.items ?? [])
      } else if (message.type === 'file-start') {
        this.startIncoming(message)
      } else if (message.type === 'file-chunk') {
        this.receiveChunk(message)
      } else if (message.type === 'file-end') {
        await this.finishIncoming(message)
      } else if (message.type === 'disconnect') {
        this.disconnect('SRL 已断开')
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : '酒馆桥接操作失败'
      this.send('operation-error', { requestId: message.requestId, transferId: message.transferId, error: text })
      this.emitLog(text, 'error')
    }
  }

  async sendResources(requestId, items) {
    const listed = new Map((await this.adapter.listResources()).map((item) => [item.id, item]))
    let completed = 0
    for (const requested of items) {
      const item = listed.get(requested.id)
      if (!item) continue
      const file = await this.adapter.exportResource(item)
      await this.sendFile(file, item.kind, requestId, item.name)
      completed += 1
    }
    this.send('pull-complete', { requestId, completed })
  }

  async sendFile(file, kind, requestId, displayName) {
    if (file.size > MAX_FILE_SIZE) throw new Error(`${file.name} 超过单文件 256 MB 限制`)
    const transferId = createId('st-file')
    this.send('file-start', {
      requestId,
      transferId,
      direction: 'to-srl',
      name: file.name,
      displayName,
      mimeType: file.type,
      kind,
      size: file.size,
      sha256: await sha256(file),
    })
    for (let offset = 0, index = 0; offset < file.size; offset += CHUNK_SIZE, index += 1) {
      const data = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer()
      this.send('file-chunk', { requestId, transferId, index, data }, [data])
    }
    this.send('file-end', { requestId, transferId })
  }

  startIncoming(message) {
    if (message.direction !== 'to-tavern') return
    if (message.size > MAX_FILE_SIZE) throw new Error('单文件超过 256 MB 限制')
    this.incoming.set(message.transferId, { meta: message, chunks: [], received: 0 })
  }

  receiveChunk(message) {
    const transfer = this.incoming.get(message.transferId)
    if (!transfer || !(message.data instanceof ArrayBuffer)) return
    transfer.chunks[message.index] = message.data
    transfer.received += message.data.byteLength
    if (transfer.received > transfer.meta.size) {
      this.incoming.delete(message.transferId)
      throw new Error('接收数据超过声明大小')
    }
  }

  async finishIncoming(message) {
    const transfer = this.incoming.get(message.transferId)
    if (!transfer) return
    this.incoming.delete(message.transferId)
    const blob = new Blob(transfer.chunks, { type: transfer.meta.mimeType })
    if (blob.size !== transfer.meta.size || (await sha256(blob)) !== transfer.meta.sha256) {
      throw new Error(`${transfer.meta.name} 完整性校验失败`)
    }
    const file = new File([blob], transfer.meta.name, { type: transfer.meta.mimeType })
    const result = await this.adapter.importResource(file, transfer.meta.kind, transfer.meta.conflictPolicy)
    this.send('file-result', { requestId: message.requestId, transferId: message.transferId, result })
    this.emitLog(`${file.name}：${result.status}`, 'success')
  }

  send(type, payload = {}, transfer = []) {
    if (!this.port) throw new Error('尚未连接 SRL')
    this.port.postMessage(envelope(type, payload), transfer)
  }

  disconnect(reason = '已断开') {
    if (this.port) {
      try {
        this.port.postMessage(envelope('disconnect'))
      } catch {}
      this.port.close()
    }
    this.port = null
    this.incoming.clear()
    this.emitState('idle', reason)
  }

  emitState(status, detail) {
    this.dispatchEvent(new CustomEvent('state', { detail: { status, detail, pairCode: this.pairCode } }))
  }

  emitLog(message, level = 'info') {
    this.dispatchEvent(new CustomEvent('log', { detail: { message, level, at: Date.now() } }))
  }

  destroy() {
    this.disconnect()
    window.removeEventListener('message', this.handleWindowMessage)
  }
}

export { BRIDGE_PROTOCOL, BRIDGE_VERSION }
