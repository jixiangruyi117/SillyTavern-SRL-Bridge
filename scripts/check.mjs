import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

const root = new URL('../', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'))
for (const key of ['display_name', 'loading_order', 'js', 'css', 'version']) {
  if (manifest[key] === undefined || manifest[key] === '') throw new Error(`manifest 缺少 ${key}`)
}
for (const file of [
  manifest.js,
  manifest.css,
  'settings.html',
  'bridge.html',
  'bridge.css',
  'bridge.js',
])
  await readFile(new URL(file, root))
const modules = await readdir(new URL('modules/', root))
if (!modules.includes('Protocol.js') || !modules.includes('TavernAdapter.js')) throw new Error('核心模块不完整')
const bridgeController = await readFile(new URL('modules/BridgeController.js', root), 'utf8')
if (bridgeController.includes("new URL('../bridge.html'")) {
  throw new Error('同浏览器连接不得再通过中间页 iframe 打开 SRL')
}
if (!bridgeController.includes('window.open(target.href')) {
  throw new Error('同浏览器连接必须直接打开原始 SRL 顶层页面')
}
console.log(`扩展结构检查通过：${path.basename(new URL(root).pathname)}`)
