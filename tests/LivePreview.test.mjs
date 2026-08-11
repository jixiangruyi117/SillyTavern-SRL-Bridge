import assert from 'node:assert/strict'
import test from 'node:test'

import { parseLivePreviewPayload } from '../modules/LivePreview.js'

test('只接受受限的角色开场白临时预览载荷', () => {
  const payload = parseLivePreviewPayload(
    JSON.stringify({
      format: 'srl-live-tavern-preview',
      version: 1,
      kind: 'characterGreeting',
      title: '测试角色',
      characterName: '小雪',
      greetings: ['你好'],
    }),
  )
  assert.equal(payload.kind, 'characterGreeting')
  assert.deepEqual(payload.greetings, ['你好'])
})

test('拒绝任意类型和超长 CSS 载荷', () => {
  assert.throws(() => parseLivePreviewPayload('{"format":"other"}'))
  assert.throws(() =>
    parseLivePreviewPayload(
      JSON.stringify({
        format: 'srl-live-tavern-preview',
        version: 1,
        kind: 'beautification',
        css: 'x'.repeat(200_001),
      }),
    ),
  )
})

test('接受受限的前端了么状态栏临时预览载荷', () => {
  const payload = parseLivePreviewPayload(
    JSON.stringify({
      format: 'srl-live-tavern-preview',
      version: 1,
      kind: 'frontendStatus',
      title: '状态栏',
      html: '<section>在线</section>',
      css: '#srl-live-preview-message section { color: red; }',
    }),
  )
  assert.equal(payload.kind, 'frontendStatus')
  assert.equal(payload.html, '<section>在线</section>')
})
