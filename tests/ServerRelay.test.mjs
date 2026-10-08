import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

import { exit, init } from '../server-plugin/index.mjs'

test('the plugin queue fits the maximum eight-chunk Base64 window', async () => {
  const routes = new Map()
  const router = Object.fromEntries(['get', 'post', 'put', 'delete'].map(method => [method, (path, handler) => routes.set(`${method.toUpperCase()} ${path}`, handler)]))
  await init(router)
  try {
    const created = responseRecorder()
    routes.get('POST /sessions')({body: {srlUrl: 'https://srl.example.test/'}}, created)
    const joined = responseRecorder()
    routes.get('GET /join-v2')({query: {code: created.body.code}, ip: '192.0.2.25'}, joined)
    const data = Buffer.alloc(256 * 1024).toString('base64')
    for (let index = 0; index < 8; index++) {
      const response = responseRecorder()
      routes.get('POST /messages')({body: {code: created.body.code, token: created.body.controllerToken, message: {type: 'file-chunk', index, data: {__srlBuffer: data}}}}, response)
      assert.equal(response.statusCode, 204)
    }
  } finally { await exit() }
})

test('legacy relay shares one CSRF read and pipelines chunks after their file-start POST', async () => {
  let csrfReads = 0, active = 0, maximum = 0, releaseStart
  const calls = []
  const context = vm.createContext({
    URL, ArrayBuffer, Uint8Array, btoa, atob, Response,
    document: {getElementById: () => ({addEventListener() {}, textContent: ''})},
    window: {__SRL_RELAY__: {code: 'AB23CD45', token: 'token', srlUrl: 'https://srl.example/', srlOrigin: 'https://srl.example'}, location: {origin: 'https://tavern.example'}, opener: {closed: false, postMessage() {}}, addEventListener() {}, setTimeout() {}, setInterval() {}, clearInterval() {}},
    fetch: async (url, init) => {
      if (url === '/csrf-token') { csrfReads++; return Response.json({token: 'csrf'}) }
      const type = JSON.parse(init.body).message.type; calls.push(type)
      if (type === 'file-start') await new Promise(resolve => {releaseStart = resolve})
      if (type === 'file-chunk') { active++; maximum = Math.max(maximum, active); await new Promise(resolve => setTimeout(resolve, 5)); active-- }
      return new Response(null, {status: 204})
    },
  })
  vm.runInContext(await readFile(new URL('../server-plugin/relay.js', import.meta.url), 'utf8'), context)
  const api = vm.runInContext('({queueSend})', context)
  const start = api.queueSend({type: 'file-start'})
  const chunks = [api.queueSend({type: 'file-chunk', index: 0}), api.queueSend({type: 'file-chunk', index: 1})]
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, ['file-start'])
  releaseStart(); await Promise.all([start, ...chunks])
  assert.equal(csrfReads, 1); assert.equal(maximum, 2)
})

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    status(code) {
      this.statusCode = code
      return this
    },
    setHeader(name, value) {
      this.headers[name] = value
    },
    type(value) {
      this.headers['Content-Type'] = value
      return this
    },
    json(value) {
      this.body = value
      return this
    },
    send(value) {
      this.body = value
      return this
    },
    sendStatus(code) {
      this.statusCode = code
      return this
    },
  }
}

test('returns exact sizes for requested Tavern files without reading their contents', async () => {
  const routes = new Map()
  const router = {
    get(route, handler) { routes.set(`GET ${route}`, handler) },
    post(route, handler) { routes.set(`POST ${route}`, handler) },
    put(route, handler) { routes.set(`PUT ${route}`, handler) },
    delete(route, handler) { routes.set(`DELETE ${route}`, handler) },
  }
  const root = await mkdtemp(path.join(os.tmpdir(), 'srl-bridge-size-'))
  const characters = path.join(root, 'characters')
  const worlds = path.join(root, 'worlds')
  await mkdir(characters)
  await mkdir(worlds)
  await writeFile(path.join(characters, '角色.png'), Buffer.from([1, 2, 3, 4]))
  await writeFile(path.join(worlds, '世界书.json'), Buffer.from([5, 6, 7]))
  await init(router)
  try {
    const response = responseRecorder()
    await routes.get('POST /resource-sizes')(
      {
        user: { directories: { characters, worlds } },
        body: {
          items: [
            { id: 'character:角色.png', kind: 'character', name: '角色.png' },
            { id: 'worldBook:世界书', kind: 'worldBook', name: '世界书' },
            { id: 'bad', kind: 'worldBook', name: '../outside' },
            { id: 'unknown', kind: 'settings', name: 'settings.json' },
          ],
        },
      },
      response,
    )
    assert.deepEqual(response.body, {
      sizes: { 'character:角色.png': 4, 'worldBook:世界书': 3 },
    })
  } finally {
    await exit()
    await rm(root, { recursive: true, force: true })
  }
})

test('allows a second browser to join with the short-lived device code', async () => {
  const routes = new Map()
  const router = {
    get(path, handler) {
      routes.set(`GET ${path}`, handler)
    },
    post(path, handler) {
      routes.set(`POST ${path}`, handler)
    },
    put(path, handler) {
      routes.set(`PUT ${path}`, handler)
    },
    delete(path, handler) {
      routes.set(`DELETE ${path}`, handler)
    },
  }
  await init(router)
  try {
    const created = responseRecorder()
    routes.get('POST /sessions')(
      {
        body: { srlUrl: 'https://srl.example.test/' },
        user: { profile: { handle: 'tavern-browser' } },
      },
      created,
    )
    assert.match(created.body.code, /^[2-9A-HJ-NP-Z]{8}$/u)

    const joined = responseRecorder()
    routes.get('GET /join-v2')(
      {
        query: {
          code: created.body.code,
          target: 'https://another-entry.example.test/?from=android-browser',
        },
        ip: '198.51.100.24',
        user: { profile: { handle: 'different-browser-session' } },
      },
      joined,
    )
    assert.equal(joined.statusCode, 200)
    assert.equal(joined.headers['Cross-Origin-Opener-Policy'], 'unsafe-none')
    assert.match(joined.body, /__SRL_RELAY__/u)
    assert.match(joined.body, /https:\\u002F\\u002Fsrl\.example\.test\\u002F|https:\/\/srl\.example\.test\//u)
    assert.doesNotMatch(joined.body, /<iframe/u)
    assert.match(joined.body, /原来的 HTTPS 资源库/u)
  } finally {
    await exit()
  }
})

test('allows joining with only the device code', async () => {
  const routes = new Map()
  const router = {
    get(path, handler) {
      routes.set(`GET ${path}`, handler)
    },
    post(path, handler) {
      routes.set(`POST ${path}`, handler)
    },
    put(path, handler) {
      routes.set(`PUT ${path}`, handler)
    },
    delete(path, handler) {
      routes.set(`DELETE ${path}`, handler)
    },
  }
  await init(router)
  try {
    const created = responseRecorder()
    routes.get('POST /sessions')(
      { body: { srlUrl: 'https://srl.example.test/library' } },
      created,
    )
    const joined = responseRecorder()
    routes.get('GET /join-v2')(
      {
        query: { code: created.body.code },
        ip: '198.51.100.25',
      },
      joined,
    )
    assert.equal(joined.statusCode, 200)
    assert.match(joined.body, /__SRL_RELAY__/u)
  } finally {
    await exit()
  }
})

test('an active relay expires when one side stops polling despite the other side sending', async () => {
  const routes = new Map()
  const router = {
    get(path, handler) { routes.set(`GET ${path}`, handler) },
    post(path, handler) { routes.set(`POST ${path}`, handler) },
    put(path, handler) { routes.set(`PUT ${path}`, handler) },
    delete(path, handler) { routes.set(`DELETE ${path}`, handler) },
  }
  const originalNow = Date.now
  let now = originalNow()
  Date.now = () => now
  await init(router)
  try {
    const created = responseRecorder()
    routes.get('POST /sessions')({ body: { srlUrl: 'https://srl.example.test/' } }, created)
    const joined = responseRecorder()
    routes.get('GET /join-v2')({ query: { code: created.body.code }, ip: '198.51.100.41' }, joined)
    assert.equal(joined.statusCode, 200)

    now += 40_000
    const sent = responseRecorder()
    routes.get('POST /messages')({ body: {
      code: created.body.code, token: created.body.controllerToken,
      message: { type: 'still-here' },
    } }, sent)
    assert.equal(sent.statusCode, 204)

    now += 36_000
    const expired = responseRecorder()
    routes.get('POST /poll')({ body: {
      code: created.body.code, token: created.body.controllerToken,
    } }, expired)
    assert.equal(expired.statusCode, 410)
    assert.equal(expired.body.closed, true)
  } finally {
    Date.now = originalNow
    await exit()
  }
})

test('creates a short-lived local direct session and requires its bearer token', async () => {
  const routes = new Map()
  const router = {
    get(path, handler) { routes.set(`GET ${path}`, handler) },
    post(path, handler) { routes.set(`POST ${path}`, handler) },
    put(path, handler) { routes.set(`PUT ${path}`, handler) },
    delete(path, handler) { routes.set(`DELETE ${path}`, handler) },
  }
  await init(router)
  try {
    const created = responseRecorder()
    routes.get('POST /direct/sessions')({}, created)
    assert.match(created.body.sessionId, /^[A-Za-z0-9_-]{12,}$/u)
    assert.match(created.body.token, /^[A-Za-z0-9_-]{32,}$/u)

    const denied = responseRecorder()
    routes.get('PUT /direct/sessions/:sessionId')(
      Object.assign(Readable.from([Buffer.from('blocked')]), {
        params: { sessionId: created.body.sessionId },
        headers: { 'content-length': '7' },
      }),
      denied,
    )
    assert.equal(denied.statusCode, 403)

    let resolveUpload
    const uploadedDone = new Promise((resolve) => {
      resolveUpload = resolve
    })
    const uploaded = responseRecorder()
    const uploadJson = uploaded.json.bind(uploaded)
    uploaded.json = (value) => {
      uploadJson(value)
      resolveUpload()
      return uploaded
    }
    const request = Object.assign(Readable.from([Buffer.from('local-data')]), {
      params: { sessionId: created.body.sessionId },
      headers: {
        'content-length': '10',
        'content-type': 'application/octet-stream',
        'x-srl-direct-token': created.body.token,
        'x-srl-file-name': 'safe.json',
      },
    })
    routes.get('PUT /direct/sessions/:sessionId')(request, uploaded)
    await uploadedDone
    assert.equal(uploaded.body.ok, true)
    assert.equal(uploaded.body.size, 10)
    assert.match(uploaded.body.sha256, /^[a-f0-9]{64}$/u)
  } finally {
    await exit()
  }
})

test('requires Tavern-side approval before a local APK relay can connect without a device code', async () => {
  const routes = new Map()
  const router = {
    get(path, handler) { routes.set(`GET ${path}`, handler) },
    post(path, handler) { routes.set(`POST ${path}`, handler) },
    put(path, handler) { routes.set(`PUT ${path}`, handler) },
    delete(path, handler) { routes.set(`DELETE ${path}`, handler) },
  }
  await init(router)
  try {
    const local = { socket: { remoteAddress: '127.0.0.1' } }
    const key = 'a'.repeat(32)
    const registered = responseRecorder()
    routes.get('POST /local-pair/register')({ ...local, headers: { 'x-srl-local-pair-key': key } }, registered)
    assert.equal(registered.body.ok, true)

    const requested = responseRecorder()
    routes.get('POST /local-pair/requests')(
      { ...local, body: { srlUrl: 'https://srl.example.test/' } },
      requested,
    )
    assert.match(requested.body.code, /^[2-9A-HJ-NP-Z]{8}$/u)
    assert.match(requested.body.participantToken, /^[A-Za-z0-9_-]{32,}$/u)

    const refreshedKey = 'b'.repeat(32)
    const reRegistered = responseRecorder()
    routes.get('POST /local-pair/register')(
      { ...local, headers: { 'x-srl-local-pair-key': refreshedKey } },
      reRegistered,
    )
    assert.equal(reRegistered.body.ok, true)

    const staleKey = responseRecorder()
    routes.get('GET /local-pair/requests')({ ...local, headers: { 'x-srl-local-pair-key': key } }, staleKey)
    assert.equal(staleKey.statusCode, 401)

    const pending = responseRecorder()
    routes.get('GET /local-pair/requests')({ ...local, headers: { 'x-srl-local-pair-key': refreshedKey } }, pending)
    assert.deepEqual(pending.body.requests.map((item) => item.code), [requested.body.code])

    const approved = responseRecorder()
    routes.get('POST /local-pair/requests/:code/approve')(
      { ...local, params: { code: requested.body.code }, headers: { 'x-srl-local-pair-key': refreshedKey } },
      approved,
    )
    assert.equal(approved.body.code, requested.body.code)
    assert.match(approved.body.controllerToken, /^[A-Za-z0-9_-]{32,}$/u)

    const hiddenAfterApproval = responseRecorder()
    routes.get('GET /local-pair/requests')(
      { ...local, headers: { 'x-srl-local-pair-key': refreshedKey } },
      hiddenAfterApproval,
    )
    assert.deepEqual(hiddenAfterApproval.body.requests, [])
  } finally {
    await exit()
  }
})
