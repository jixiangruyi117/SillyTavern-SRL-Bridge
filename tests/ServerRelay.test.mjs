import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

import { exit, init } from '../server-plugin/index.mjs'

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
