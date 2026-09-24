import test from 'node:test'
import assert from 'node:assert/strict'

import { detectHostRuntime, HOST_KINDS, waitForHostReady } from '../modules/HostRuntime.js'

test('detects ordinary SillyTavern and retains existing pairing transports', () => {
  const previousWindow = globalThis.window
  globalThis.window = {}
  try {
    const host = detectHostRuntime()
    assert.equal(host.kind, HOST_KINDS.SILLY_TAVERN)
    assert.equal(host.isTauriTavern, false)
    assert.equal(host.supportsPopupPairing, true)
    assert.equal(host.supportsServerPlugin, true)
  } finally {
    globalThis.window = previousWindow
  }
})

test('waits for TauriTavern ready before reading its SillyTavern-compatible context', async () => {
  const previousWindow = globalThis.window
  let releaseReady
  let contextReads = 0
  const context = { version: 'TauriTavern test' }
  globalThis.window = {
    __TAURITAVERN__: { ready: new Promise((resolve) => { releaseReady = resolve }) },
    SillyTavern: { getContext: () => { contextReads += 1; return context } },
  }
  try {
    const pending = waitForHostReady()
    await Promise.resolve()
    assert.equal(contextReads, 0)
    releaseReady()
    const result = await pending
    assert.equal(result.host.kind, HOST_KINDS.TAURI_TAVERN)
    assert.equal(result.host.supportsPopupPairing, false)
    assert.equal(result.host.supportsServerPlugin, false)
    assert.equal(result.context, context)
    assert.equal(contextReads, 1)
  } finally {
    globalThis.window = previousWindow
  }
})

test('recognizes the early TauriTavern main-ready marker', async () => {
  const previousWindow = globalThis.window
  const context = { version: 'ready-marker' }
  globalThis.window = {
    __TAURITAVERN_MAIN_READY__: Promise.resolve(),
    SillyTavern: { getContext: () => context },
  }
  try {
    const result = await waitForHostReady()
    assert.equal(result.host.kind, HOST_KINDS.TAURI_TAVERN)
    assert.equal(result.context, context)
  } finally {
    globalThis.window = previousWindow
  }
})

test('waits when TT installs its host object before registering the ready promise', async () => {
  const previousWindow = globalThis.window
  let contextReads = 0
  const context = { version: 'late-ready' }
  globalThis.window = {
    __TAURITAVERN__: { ready: null },
    SillyTavern: { getContext: () => { contextReads += 1; return context } },
  }
  try {
    const pending = waitForHostReady()
    await new Promise((resolve) => setTimeout(() => {
      const ready = Promise.resolve()
      globalThis.window.__TAURITAVERN_MAIN_READY__ = ready
      globalThis.window.__TAURITAVERN__.ready = ready
      resolve()
    }, 5))
    const result = await pending
    assert.equal(result.host.kind, HOST_KINDS.TAURI_TAVERN)
    assert.equal(result.context, context)
    assert.equal(contextReads, 1)
  } finally {
    globalThis.window = previousWindow
  }
})
