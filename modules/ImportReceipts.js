const RETENTION_MS = 8 * 24 * 60 * 60 * 1000
let database

function open() {
  if (!database) database = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('当前宿主无法保存导入回执，请使用不带任务恢复的旧版互传或更换宿主')); return }
    const request = indexedDB.open('srl-bridge-import-receipts', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('receipts', { keyPath: 'id' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  }).catch((error) => { database = undefined; throw error })
  return database
}

/** A started receipt is deliberately retained on failure: an import may have partially written. */
export async function reserveImport(id, fingerprint) {
  if (!/^[\w-]{16,80}$/.test(id)) throw new Error('导入任务 ID 无效')
  const db = await open()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('receipts', 'readwrite')
    const store = tx.objectStore('receipts')
    let result
    let failure
    const request = store.getAll()
    request.onsuccess = () => {
      const now = Date.now()
      const rows = request.result.filter((row) => {
        if (row.at < now - RETENTION_MS) { store.delete(row.id); return false }
        return true
      })
      const existing = rows.find((row) => row.id === id)
      if (existing) {
        if (existing.fingerprint !== fingerprint) failure = new Error('重试任务内容或目标发生变化，请重新选择资源发起传输')
        else if (existing.status === 'done') result = existing.result
        else failure = new Error('上次导入的结果尚不确定。请先检查酒馆中是否已有该资源，再重新发起传输；不会自动重复写入。')
      } else if (rows.length >= 2000) failure = new Error('导入回执已满，请稍后重试')
      else store.put({ id, fingerprint, status: 'started', at: now })
    }
    tx.oncomplete = () => failure ? reject(failure) : resolve(result)
    tx.onabort = tx.onerror = () => reject(tx.error || new Error('无法保存导入回执'))
  })
}

export async function completeImport(id, fingerprint, result) {
  const db = await open()
  await new Promise((resolve, reject) => {
    const tx = db.transaction('receipts', 'readwrite')
    tx.objectStore('receipts').put({ id, fingerprint, status: 'done', result, at: Date.now() })
    tx.oncomplete = resolve
    tx.onabort = tx.onerror = () => reject(tx.error || new Error('无法保存导入结果；请核对酒馆列表'))
  })
}
