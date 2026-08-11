import {
  BRIDGE_PROTOCOL,
  BRIDGE_EXTENSION_VERSION,
  BRIDGE_VERSION,
  CHUNK_SIZE,
  DEFAULT_IN_FLIGHT_CHUNKS,
  MAX_IN_FLIGHT_CHUNKS,
  MAX_FILE_SIZE,
  MIN_IN_FLIGHT_CHUNKS,
  createId,
  envelope,
  isBridgeEnvelope,
  sha256,
  COMPRESSIBLE_KINDS,
  COMPRESS_MIN_BYTES,
  supportsGzip,
  gzipBlob,
  gunzipBlob,
} from './Protocol.js'
import { RelayPort } from './RelayPort.js'

export class BridgeController extends EventTarget {
  constructor(adapter) {
    super()
    this.adapter = adapter
    this.popup = null
    this.port = null
    this.channel = ''
    this.pairCode = ''
    this.deviceCode = ''
    this.expectedSrlOrigin = ''
    this.localAuto = false
    this.localPairKey = ''
    this.localPairTimer = undefined
    this.localPairRequest = undefined
    this.incoming = new Map()
    this.chunkAcks = new Map()
    this.messageChain = Promise.resolve()
    this.handleWindowMessage = this.handleWindowMessage.bind(this)
    window.addEventListener('message', this.handleWindowMessage)
  }

  open(srlUrl) {
    const target = new URL(srlUrl)
    if (!['http:', 'https:'].includes(target.protocol))
      throw new Error('SRL 地址必须使用 HTTP 或 HTTPS')
    this.disconnect('正在建立新连接')
    this.channel = crypto.randomUUID()
    this.deviceCode = ''
    this.pairCode = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0')
    this.expectedSrlOrigin = target.origin
    target.searchParams.set('srlBridge', this.channel)
    target.searchParams.set('pair', this.pairCode)
    target.searchParams.set('stOrigin', window.location.origin)
    // 直接打开 SRL，避免 Android 把中间页打开成独立标签后丢失 opener，
    // 也避免 iframe 产生一套按顶层站点分区的空白 IndexedDB。
    this.popup = window.open(target.href, `srl-tavern-bridge-${this.channel}`)
    if (!this.popup) throw new Error('浏览器阻止了新窗口，请允许酒馆打开 SRL')
    this.emitState('waiting', '等待 SRL 确认配对')
    return this.pairCode
  }

  async openDevice(srlUrl) {
    const target = new URL(srlUrl)
    if (!['http:', 'https:'].includes(target.protocol))
      throw new Error('SRL 地址必须使用 HTTP 或 HTTPS')
    this.disconnect('正在建立设备码连接')
    let session
    let relayBase
    const secureRelayBase = new URL('/api/bridge/', target.origin)
    try {
      const response = await fetch(new URL('sessions', secureRelayBase), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ srlUrl: target.href }),
        cache: 'no-store',
        mode: 'cors',
      })
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}))
        throw new Error(detail.error || `HTTPS 中继返回 HTTP ${response.status}`)
      }
      session = await response.json()
      relayBase = new URL(session.relayBase || '/api/bridge/', target.origin).href
    } catch (secureError) {
      const response = await fetch('/api/plugins/srl-bridge/sessions', {
        method: 'POST',
        headers: this.adapter.context.getRequestHeaders(),
        body: JSON.stringify({ srlUrl: target.href }),
        cache: 'no-store',
      })
      if (!response.ok) {
        if (response.status === 404) {
          throw new Error(
            `HTTPS 中继不可用，且本机设备码服务尚未安装。${secureError instanceof Error ? ` 原因：${secureError.message}` : ''}`,
          )
        }
        throw new Error(`创建设备码失败（HTTP ${response.status}）`)
      }
      session = await response.json()
      relayBase = new URL('/api/plugins/srl-bridge/', window.location.origin).href
    }
    this.deviceCode = session.code
    this.channel = `relay-${session.code}`
    this.pairCode = session.pairCode
    this.port = new RelayPort(this.adapter.context, session, relayBase)
    this.port.onmessage = (event) => {
      this.messageChain = this.messageChain
        .then(() => this.handlePortMessage(event.data))
        .catch((error) =>
          this.emitLog(error instanceof Error ? error.message : '通信处理失败', 'error'),
        )
    }
    this.port.onerror = (error) => {
      this.emitState('idle', error instanceof Error ? error.message : '设备码中继已断开')
    }
    this.port.start()
    this.emitState('waiting', '请在原来的 SRL 输入设备码；无需打开新窗口')
    return session
  }

  localPairHeaders() {
    return {
      ...this.adapter.context.getRequestHeaders(),
      'X-SRL-Local-Pair-Key': this.localPairKey,
    }
  }

  async startLocalAutoPairing() {
    if (!this.canUseLocalDirect()) return false
    if (!this.localPairKey) this.localPairKey = crypto.randomUUID().replace(/-/g, '')
    const response = await fetch('/api/plugins/srl-bridge/local-pair/register', {
      method: 'POST',
      headers: this.localPairHeaders(),
      cache: 'no-store',
    })
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}))
      throw new Error(detail.error || `Unable to register local pairing (HTTP ${response.status})`)
    }
    if (!this.localPairTimer) {
      this.localPairTimer = window.setInterval(() => void this.pollLocalPairRequest(), 1500)
    }
    await this.pollLocalPairRequest()
    return true
  }

  async pollLocalPairRequest() {
    if (!this.canUseLocalDirect() || this.localPairRequest || this.port) return
    const response = await fetch('/api/plugins/srl-bridge/local-pair/requests', {
      headers: this.localPairHeaders(),
      cache: 'no-store',
    })
    if (response.status === 401) {
      await this.startLocalAutoPairing()
      return
    }
    if (!response.ok) return
    const value = await response.json()
    const request = Array.isArray(value?.requests) ? value.requests[0] : undefined
    const code = typeof request?.code === 'string' ? request.code : ''
    if (!/^[2-9A-HJ-NP-Z]{8}$/u.test(code)) return
    this.localPairRequest = { code }
    this.dispatchEvent(new CustomEvent('local-pair-request', { detail: this.localPairRequest }))
  }

  async approveLocalAutoPairing() {
    const pending = this.localPairRequest
    if (!pending) throw new Error('No local APK connection is waiting for approval')
    const response = await fetch(
      `/api/plugins/srl-bridge/local-pair/requests/${encodeURIComponent(pending.code)}/approve`,
      { method: 'POST', headers: this.localPairHeaders(), cache: 'no-store' },
    )
    const value = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(value.error || `Unable to approve local pairing (HTTP ${response.status})`)
    if (
      !/^[2-9A-HJ-NP-Z]{8}$/u.test(String(value.code ?? '')) ||
      !/^[A-Za-z0-9_-]{32,}$/u.test(String(value.controllerToken ?? ''))
    ) {
      throw new Error('The local pairing response is incomplete')
    }
    this.port?.close()
    this.localAuto = true
    this.localPairRequest = undefined
    this.deviceCode = ''
    this.pairCode = ''
    this.channel = `local-${value.code}`
    this.port = new RelayPort(this.adapter.context, {
      code: value.code,
      controllerToken: value.controllerToken,
    }, value.relayBase || '/api/plugins/srl-bridge/')
    this.port.onmessage = (event) => {
      this.messageChain = this.messageChain
        .then(() => this.handlePortMessage(event.data))
        .catch((error) => this.emitLog(error instanceof Error ? error.message : 'Local relay message failed', 'error'))
    }
    this.port.onerror = (error) => {
      this.emitState('idle', error instanceof Error ? error.message : 'The local relay disconnected')
    }
    this.port.start()
    this.emitState('waiting', '已允许本机 APK 连接，正在完成握手')
  }

  stopLocalAutoPairing() {
    if (this.localPairTimer) window.clearInterval(this.localPairTimer)
    this.localPairTimer = undefined
    this.localPairRequest = undefined
    this.localPairKey = ''
  }

  handleWindowMessage(event) {
    if (event.origin !== this.expectedSrlOrigin || event.source !== this.popup) return
    const message = event.data
    if (
      !isBridgeEnvelope(message) ||
      message.type !== 'srl-hello' ||
      message.channel !== this.channel
    )
      return
    this.port?.close()
    const pair = new MessageChannel()
    this.port = pair.port1
    this.port.onmessage = (portEvent) => {
      this.messageChain = this.messageChain
        .then(() => this.handlePortMessage(portEvent.data))
        .catch((error) =>
          this.emitLog(error instanceof Error ? error.message : '通信处理失败', 'error'),
        )
    }
    this.port.start()
    event.source.postMessage(
      envelope('st-port', {
        channel: this.channel,
        pairCode: this.pairCode,
        capabilities: [
          'character',
          'worldBook',
          'preset',
          'regexGlobal',
          'regexCharacter',
          'regexPreset',
          'quickReply',
          'theme',
          'userPersona',
          'userAvatar',
        ],
        bridgeVersion: BRIDGE_EXTENSION_VERSION,
        tavernVersion: window.SillyTavern?.getContext?.().version || '1.18+',
      }),
      this.expectedSrlOrigin,
      [pair.port2],
    )
    this.emitState('pairing', '请在 SRL 核对配对码')
  }

  async handlePortMessage(message) {
    if (!isBridgeEnvelope(message)) return
    try {
      if (message.type === 'relay-joined') {
        if (this.localAuto) {
          this.send('st-ready', {
            bridgeVersion: BRIDGE_EXTENSION_VERSION,
            capabilities: [
              'character',
              'worldBook',
              'preset',
              'regexGlobal',
              'regexCharacter',
              'regexPreset',
              'quickReply',
              'theme',
              'scriptGlobal',
              'scriptCharacter',
              'scriptPreset',
              'userPersona',
              'userAvatar',
              'local-direct-v1',
              ...(supportsGzip() ? ['gzip'] : []),
            ],
          })
          this.emitState('connected', '已连接本机 APK；文件将直接在 127.0.0.1 上传输')
          return
        }
        this.emitState('pairing', '另一浏览器已加入，请核对六位确认码')
      } else if (message.type === 'srl-accept') {
        if (message.pairCode !== this.pairCode) throw new Error('配对码不一致')
        this.srlCapabilities = Array.isArray(message.capabilities)
          ? message.capabilities.filter((value) => typeof value === 'string')
          : []
        this.send('st-ready', {
          bridgeVersion: BRIDGE_EXTENSION_VERSION,
          capabilities: [
            'character',
            'worldBook',
            'preset',
            'regexGlobal',
            'regexCharacter',
            'regexPreset',
            'quickReply',
            'theme',
            'scriptGlobal',
            'scriptCharacter',
            'scriptPreset',
            'userPersona',
            'userAvatar',
            ...(this.canUseLocalDirect() ? ['local-direct-v1'] : []),
            ...(supportsGzip() ? ['gzip'] : []),
          ],
        })
        this.emitState('connected', '已连接 SRL')
      } else if (message.type === 'list-request') {
        this.send('list-response', {
          requestId: message.requestId,
          items: await this.adapter.listResources(),
        })
      } else if (message.type === 'pull-request') {
        this.runLongOperation(message, () =>
          this.sendResources(message.requestId, message.items ?? [], message.localDirect === true),
        )
      } else if (message.type === 'local-direct-session-request') {
        const session = await this.createLocalDirectSession()
        await this.send('local-direct-session', { requestId: message.requestId, session })
      } else if (message.type === 'file-start') {
        await this.startIncoming(message)
      } else if (message.type === 'file-chunk') {
        this.receiveChunk(message)
        await this.send('file-chunk-ack', {
          transferId: message.transferId,
          index: message.index,
        })
      } else if (message.type === 'file-chunk-ack') {
        this.resolveChunkAck(message)
      } else if (message.type === 'file-end') {
        await this.finishIncoming(message)
      } else if (message.type === 'disconnect') {
        this.disconnect('SRL 已断开')
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : '酒馆桥接操作失败'
      try {
        await this.send('operation-error', {
          requestId: message.requestId,
          transferId: message.transferId,
          error: text,
        })
      } catch {}
      this.emitLog(text, 'error')
    }
  }

  runLongOperation(message, task) {
    Promise.resolve()
      .then(task)
      .catch(async (error) => {
        const text = error instanceof Error ? error.message : '酒馆桥接操作失败'
        try {
          await this.send('operation-error', {
            requestId: message.requestId,
            transferId: message.transferId,
            error: text,
          })
        } catch {}
        this.emitLog(text, 'error')
      })
  }

  async sendResources(requestId, items, localDirect = false) {
    const listed = new Map((await this.adapter.listResources()).map((item) => [item.id, item]))
    let completed = 0
    for (const requested of items) {
      const item = listed.get(requested.id)
      if (!item) continue
      const file = await this.adapter.exportResource(item)
      await this.sendFile(file, item.kind, requestId, item.name, localDirect)
      completed += 1
    }
    await this.send('pull-complete', { requestId, completed })
  }

  async sendFile(file, kind, requestId, displayName, localDirect = false) {
    if (file.size > MAX_FILE_SIZE) throw new Error(`${file.name} 超过单文件 256 MB 限制`)
    const transferId = createId('st-file')
    const useGzip =
      Array.isArray(this.srlCapabilities) &&
      this.srlCapabilities.includes('gzip') &&
      supportsGzip() &&
      COMPRESSIBLE_KINDS.includes(kind) &&
      file.size > COMPRESS_MIN_BYTES
    const payload = useGzip ? await gzipBlob(file) : file
    let directSession
    if (localDirect) {
      try {
        directSession = await this.createLocalDirectSession()
        await this.uploadLocalDirectFile(directSession, payload)
      } catch (error) {
        if (directSession) await this.removeLocalDirectFile(directSession)
        directSession = undefined
        this.emitLog(`本机直传不可用，已回退设备码传输：${file.name}`, 'warning')
      }
    }
    await this.send('file-start', {
      requestId,
      transferId,
      direction: 'to-srl',
      name: file.name,
      displayName,
      mimeType: file.type,
      kind,
      size: payload.size,
      sha256: await sha256(payload),
      ...(directSession ? { localDirectSession: directSession } : {}),
      ...(useGzip ? { contentEncoding: 'gzip', rawSize: file.size } : {}),
    })
    if (!directSession) await this.sendFileChunks(payload, requestId, transferId)
    await this.send('file-end', { requestId, transferId })
  }

  async startIncoming(message) {
    if (message.direction !== 'to-tavern') return
    if (message.size > MAX_FILE_SIZE) throw new Error('单文件超过 256 MB 限制')
    const directRequested = Object.hasOwn(message, 'localDirectSession')
    const localDirectSession = this.readLocalDirectSession(message.localDirectSession)
    if (directRequested && !localDirectSession) throw new Error('资源库发送了无效的本机直传会话')
    if (localDirectSession) {
      const file = await this.downloadLocalDirectFile(localDirectSession, message.name, message.mimeType)
      this.incoming.set(message.transferId, { meta: message, chunks: [], received: file.size, file, localDirectSession })
      return
    }
    this.incoming.set(message.transferId, {
      meta: message,
      chunks: [],
      received: 0,
    })
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
    const blob = transfer.file ?? new Blob(transfer.chunks, { type: transfer.meta.mimeType })
    if (blob.size !== transfer.meta.size || (await sha256(blob)) !== transfer.meta.sha256) {
      throw new Error(`${transfer.meta.name} 完整性校验失败`)
    }
    let content = blob
    if (transfer.meta.contentEncoding === 'gzip') {
      content = await gunzipBlob(blob)
      const rawSize = Number(transfer.meta.rawSize)
      if (Number.isFinite(rawSize) && rawSize > 0 && content.size !== rawSize) {
        throw new Error(`${transfer.meta.name} 解压后大小与声明不符`)
      }
    }
    const file = new File([content], transfer.meta.name, {
      type: transfer.meta.mimeType,
    })
    const result = await this.adapter.importResource(
      file,
      transfer.meta.kind,
      transfer.meta.conflictPolicy,
      transfer.meta,
    )
    if (transfer.localDirectSession) await this.removeLocalDirectFile(transfer.localDirectSession)
    await this.send('file-result', {
      requestId: message.requestId,
      transferId: message.transferId,
      result,
    })
    this.emitLog(`${file.name}：${result.status}`, 'success')
  }

  canUseLocalDirect() {
    return window.location.origin === 'http://127.0.0.1:8000'
  }

  async createLocalDirectSession() {
    if (!this.canUseLocalDirect()) throw new Error('本机直传只支持 127.0.0.1:8000 的酒馆')
    const response = await fetch('/api/plugins/srl-bridge/direct/sessions', {
      method: 'POST',
      headers: this.adapter.context.getRequestHeaders(),
      cache: 'no-store',
    })
    if (!response.ok) throw new Error(`创建本机直传会话失败（HTTP ${response.status}）`)
    const value = await response.json()
    const session = {
      sessionId: typeof value?.sessionId === 'string' ? value.sessionId : '',
      token: typeof value?.token === 'string' ? value.token : '',
      origin: window.location.origin,
      maxFileSize: Number(value?.maxFileSize),
    }
    if (
      !/^[A-Za-z0-9_-]{12,}$/u.test(session.sessionId) ||
      !/^[A-Za-z0-9_-]{32,}$/u.test(session.token) ||
      !Number.isInteger(session.maxFileSize) ||
      session.maxFileSize < 1 ||
      session.maxFileSize > MAX_FILE_SIZE
    ) {
      throw new Error('本机直传会话返回无效')
    }
    return session
  }

  readLocalDirectSession(value) {
    if (!value || typeof value !== 'object') return undefined
    const session = value
    if (
      session.origin !== window.location.origin ||
      !/^[A-Za-z0-9_-]{12,}$/u.test(String(session.sessionId ?? '')) ||
      !/^[A-Za-z0-9_-]{32,}$/u.test(String(session.token ?? '')) ||
      !Number.isInteger(session.maxFileSize) ||
      session.maxFileSize < 1 ||
      session.maxFileSize > MAX_FILE_SIZE
    ) return undefined
    return session
  }

  localDirectUrl(session) {
    return `/api/plugins/srl-bridge/direct/sessions/${encodeURIComponent(session.sessionId)}`
  }

  async uploadLocalDirectFile(session, file) {
    const response = await fetch(this.localDirectUrl(session), {
      method: 'PUT',
      headers: {
        ...this.adapter.context.getRequestHeaders(),
        'Content-Type': file.type || 'application/octet-stream',
        'X-SRL-Direct-Token': session.token,
        'X-SRL-File-Name': file.name,
      },
      body: file,
      cache: 'no-store',
    })
    if (!response.ok) throw new Error(`写入本机直传文件失败（HTTP ${response.status}）`)
  }

  async downloadLocalDirectFile(session, name, mimeType) {
    const response = await fetch(this.localDirectUrl(session), {
      headers: { ...this.adapter.context.getRequestHeaders(), 'X-SRL-Direct-Token': session.token },
      cache: 'no-store',
    })
    if (!response.ok) throw new Error(`读取本机直传文件失败（HTTP ${response.status}）`)
    return new File([await response.blob()], name, { type: mimeType || response.headers.get('content-type') || '' })
  }

  async removeLocalDirectFile(session) {
    await fetch(this.localDirectUrl(session), {
      method: 'DELETE',
      headers: { ...this.adapter.context.getRequestHeaders(), 'X-SRL-Direct-Token': session.token },
      cache: 'no-store',
    }).catch(() => {})
  }

  sendChunkAndWait(payload) {
    const key = `${payload.transferId}:${payload.index}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.chunkAcks.delete(key)
        reject(new Error('文件分块确认超时'))
      }, 90_000)
      this.chunkAcks.set(key, () => {
        clearTimeout(timer)
        resolve()
      })
      Promise.resolve(this.send('file-chunk', payload, [payload.data])).catch((error) => {
        clearTimeout(timer)
        this.chunkAcks.delete(key)
        reject(error)
      })
    })
  }

  async sendFileChunks(file, requestId, transferId) {
    const pending = new Set()
    let inFlightLimit = DEFAULT_IN_FLIGHT_CHUNKS
    let fastAckStreak = 0
    const adjustWindow = (elapsedMs) => {
      if (elapsedMs < 350 && inFlightLimit < MAX_IN_FLIGHT_CHUNKS) {
        fastAckStreak += 1
        if (fastAckStreak >= inFlightLimit * 2) {
          inFlightLimit += 1
          fastAckStreak = 0
        }
        return
      }
      fastAckStreak = 0
      if (elapsedMs > 1500 && inFlightLimit > MIN_IN_FLIGHT_CHUNKS) {
        inFlightLimit -= 1
      }
    }
    try {
      for (let offset = 0, index = 0; offset < file.size; offset += CHUNK_SIZE, index += 1) {
        const data = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer()
        const sentAt = performance.now()
        const ack = this.sendChunkAndWait({ requestId, transferId, index, data }).then(() => {
          adjustWindow(performance.now() - sentAt)
        })
        pending.add(ack)
        ack.then(
          () => pending.delete(ack),
          () => pending.delete(ack),
        )
        if (pending.size >= inFlightLimit) await Promise.race(pending)
      }
      await Promise.all([...pending])
    } catch (error) {
      await Promise.allSettled([...pending])
      throw error
    }
  }

  resolveChunkAck(message) {
    const key = `${message.transferId}:${message.index}`
    const resolve = this.chunkAcks.get(key)
    this.chunkAcks.delete(key)
    resolve?.()
  }

  send(type, payload = {}, transfer = []) {
    if (!this.port) throw new Error('尚未连接 SRL')
    return this.port.postMessage(envelope(type, payload), transfer)
  }

  disconnect(reason = '已断开') {
    if (this.port) {
      try {
        Promise.resolve(this.port.postMessage(envelope('disconnect'))).catch(() => {})
      } catch {}
      this.port.close()
    }
    this.port = null
    this.localAuto = false
    if (this.popup && !this.popup.closed) this.popup.close()
    this.popup = null
    this.incoming.clear()
    this.chunkAcks.clear()
    this.emitState('idle', reason)
  }

  emitState(status, detail) {
    this.dispatchEvent(
      new CustomEvent('state', {
        detail: {
          status,
          detail,
          pairCode: this.pairCode,
          deviceCode: this.deviceCode,
        },
      }),
    )
  }

  emitLog(message, level = 'info') {
    this.dispatchEvent(new CustomEvent('log', { detail: { message, level, at: Date.now() } }))
  }

  destroy() {
    this.disconnect()
    this.stopLocalAutoPairing()
    window.removeEventListener('message', this.handleWindowMessage)
  }
}

export { BRIDGE_EXTENSION_VERSION, BRIDGE_PROTOCOL, BRIDGE_VERSION }
