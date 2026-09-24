import 'fake-indexeddb/auto'
import test from 'node:test'
import assert from 'node:assert/strict'
import { reserveImport, completeImport } from '../modules/ImportReceipts.js'

test('a completed import returns its receipt; changed or uncertain retries never write twice', async () => {
  const id = crypto.randomUUID()
  assert.equal(await reserveImport(id, 'original-content-and-target'), undefined)
  await assert.rejects(reserveImport(id, 'original-content-and-target'), /尚不确定/)
  const result = { name: 'world', status: 'created' }
  await completeImport(id, 'original-content-and-target', result)
  assert.deepEqual(await reserveImport(id, 'original-content-and-target'), result)
  await assert.rejects(reserveImport(id, 'changed-content'), /内容或目标发生变化/)
})

test('concurrent reservations serialize and only one is permitted to import', async () => {
  const id = crypto.randomUUID()
  const results = await Promise.allSettled([reserveImport(id, 'same'), reserveImport(id, 'same')])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1)
})
