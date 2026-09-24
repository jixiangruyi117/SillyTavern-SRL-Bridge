import { createParcel, readParcel, removeParcel } from './ParcelTransfer.js?v=0.3.35'
import { reserveImport, completeImport } from './ImportReceipts.js?v=0.3.35'
import { sha256 } from './Protocol.js?v=0.3.35'

export function attachParcelPanel(controller, getBase) {
  const panel = document.getElementById('srl-bridge-parcels')
  const list = panel.querySelector('[data-parcel=list]')
  const status = panel.querySelector('[data-parcel=status]')
  const ticket = panel.querySelector('[data-parcel=ticket]')
  const policy = panel.querySelector('[data-parcel=policy]')
  const preview = panel.querySelector('[data-parcel=preview]')
  const confirm = panel.querySelector('[data-parcel=confirm]')
  let inventory = []; let received = []; let outgoing = ''; let busy = false
  let operation; let shown = 50
  const selected = new Set()
  const get = (name) => panel.querySelector(`[data-parcel="${name}"]`)
  for (const mode of ['receive', 'send']) get(`mode-${mode}`).addEventListener('click', () => {
    if (busy) return
    for (const name of ['receive', 'send']) {
      get(`${name}-section`).hidden = name !== mode
      get(`mode-${name}`).setAttribute('aria-pressed', String(name === mode))
    }
  })
  function renderList() {
    const matching = inventory.filter((item) => item.name.toLocaleLowerCase().includes(get('search').value.toLocaleLowerCase()))
    list.replaceChildren()
    for (const item of matching.slice(0, shown)) {
      const label = document.createElement('label')
      const input = document.createElement('input'); input.type = 'checkbox'; input.value = item.id; input.checked = selected.has(item.id)
      input.addEventListener('change', () => { if (input.checked) selected.add(item.id); else selected.delete(item.id) })
      const name = document.createElement('span'); name.textContent = `${item.name} · ${item.detail || item.kind}`
      label.append(input, name); list.append(label)
    }
    get('more').hidden = matching.length <= shown
  }
  get('search').addEventListener('input', () => { shown = 50; renderList() })
  get('more').addEventListener('click', () => { shown += 50; renderList() })
  get('cancel').addEventListener('click', () => operation?.abort())
  window.addEventListener('pagehide', () => operation?.abort())
  const progress = (message) => { status.textContent = message }
  async function run(action, cancellable = false) {
    if (busy) return
    busy = true
    operation = new AbortController()
    for (const input of panel.querySelectorAll('button, input, select, textarea')) input.disabled = true
    get('cancel').hidden = !cancellable; get('cancel').disabled = false
    try { await action() } catch (error) { progress(error instanceof Error ? error.message : '暂存操作失败') }
    finally { busy = false; operation = undefined; get('cancel').hidden = true; for (const input of panel.querySelectorAll('button, input, select, textarea')) input.disabled = false }
  }
  panel.querySelector('[data-parcel=load]').addEventListener('click', () => run(async () => {
    inventory = await controller.adapter.listResources()
    selected.clear(); renderList()
    progress(`已读取 ${inventory.length} 项，请勾选要暂存的资源`)
  }))
  panel.querySelector('[data-parcel=send]').addEventListener('click', () => run(async () => {
    if (outgoing) throw new Error('请先复制口令，或删除当前暂存后再发送')
    if (selected.size > 100) throw new Error('每次最多暂存 100 项，请分批发送')
    let bytes = 0
    const files = []
    for (const item of inventory.filter((item) => selected.has(item.id))) {
      if (operation.signal.aborted) throw new Error('已取消暂存')
      const file = await controller.adapter.exportResource(item)
      bytes += file.size
      if (bytes > 16 * 1024 * 1024) throw new Error('所选内容超过 16 MiB，请分批暂存或使用实时互传')
      files.push({ file, kind: item.kind, displayName: item.name, targetName: item.name })
    }
    const result = await createParcel(getBase(), files, progress, { signal: operation.signal })
    outgoing = result.ticket; ticket.value = outgoing
    get('outgoing').hidden = false; get('selection').hidden = true
  }, true))
  panel.querySelector('[data-parcel=copy]').addEventListener('click', () => run(async () => {
    if (!outgoing) throw new Error('请先完成暂存')
    try { await navigator.clipboard.writeText(outgoing); progress('已复制口令，可以切换到资源库领取') }
    catch { ticket.disabled = false; ticket.focus(); ticket.select(); progress('请长按选中口令并复制，再切换到资源库') }
  }))
  panel.querySelector('[data-parcel=remove]').addEventListener('click', () => run(async () => {
    if (!outgoing) throw new Error('当前没有可删除的暂存')
    await removeParcel(getBase(), outgoing, { signal: operation.signal }); outgoing = ''; ticket.value = ''; progress('暂存已删除')
    get('outgoing').hidden = true; get('selection').hidden = false
  }, true))
  panel.querySelector('[data-parcel=receive]').addEventListener('click', () => run(async () => {
    received = []; preview.replaceChildren(); confirm.hidden = true; get('preview-section').hidden = true
    received = await readParcel(getBase(), panel.querySelector('[data-parcel=code]').value, progress, { signal: operation.signal })
    for (const item of received) { const li = document.createElement('li'); li.textContent = item.displayName; preview.append(li) }
    confirm.hidden = false; get('preview-section').hidden = false
  }, true))
  confirm.addEventListener('click', () => run(async () => {
    let completed = 0
    for (const item of received) {
      // Reusing the same parcel replays its receipt; it cannot silently create duplicate copies.
      const fingerprint = JSON.stringify([await sha256(item.file), item.kind, policy.value, item.targetName || '', item.file.name])
      const previous = await reserveImport(item.operationId, fingerprint)
      if (!previous) {
        const result = await controller.adapter.importResource(item.file, item.kind, policy.value, { targetName: item.targetName })
        await completeImport(item.operationId, fingerprint, result)
      }
      progress(`酒馆已确认导入 ${++completed} / ${received.length} 项`)
    }
    received = []; confirm.hidden = true
    controller.emitLog('加密暂存资源已导入；脚本保持停用', 'success')
  }))
}
