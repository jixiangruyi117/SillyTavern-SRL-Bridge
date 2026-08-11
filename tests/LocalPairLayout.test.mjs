import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('本机 APK 配对面板使用独立的单列移动端布局', async () => {
  const [html, css] = await Promise.all([
    readFile(new URL('../settings.html', import.meta.url), 'utf8'),
    readFile(new URL('../style.css', import.meta.url), 'utf8'),
  ])

  assert.match(html, /srl-bridge-local-pair-panel/)
  assert.match(css, /\.srl-bridge-local-pair-panel\s*\{[^}]*display:\s*grid/s)
  assert.match(css, /#srl-bridge-local-pair-approve\s*\{[^}]*width:\s*100%/s)
  assert.match(css, /#srl-bridge-local-pair-approve\s*\{[^}]*white-space:\s*nowrap/s)
})
