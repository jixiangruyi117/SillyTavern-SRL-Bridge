import test from 'node:test'
import assert from 'node:assert/strict'

import { BRIDGE_PROTOCOL, envelope, isBridgeEnvelope, safeFileName, uniqueName } from '../modules/Protocol.js'

test('creates and validates versioned bridge envelopes', () => {
  const message = envelope('ping', { value: 1 })
  assert.equal(message.protocol, BRIDGE_PROTOCOL)
  assert.equal(isBridgeEnvelope(message), true)
  assert.equal(isBridgeEnvelope({ ...message, version: 99 }), false)
})

test('sanitizes file names and produces deterministic conflict copies', () => {
  assert.equal(safeFileName('A/B:*?'), 'A_B___')
  assert.equal(uniqueName('Atlas', ['Atlas', 'Atlas (SRL 2)']), 'Atlas (SRL 3)')
})
