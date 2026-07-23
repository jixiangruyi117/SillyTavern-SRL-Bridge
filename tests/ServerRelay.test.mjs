import test from 'node:test'
import assert from 'node:assert/strict'

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
          target: 'https://srl.example.test/?from=another-browser',
        },
        ip: '198.51.100.24',
        user: { profile: { handle: 'different-browser-session' } },
      },
      joined,
    )
    assert.equal(joined.statusCode, 200)
    assert.equal(joined.headers['Cross-Origin-Opener-Policy'], 'unsafe-none')
    assert.match(joined.body, /__SRL_RELAY__/u)
    assert.match(joined.body, /from=another-browser/u)
    assert.doesNotMatch(joined.body, /<iframe/u)
    assert.match(joined.body, /原来的 HTTPS 资源库/u)
  } finally {
    await exit()
  }
})
