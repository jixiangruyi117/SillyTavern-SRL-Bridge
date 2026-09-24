export const HOST_KINDS = Object.freeze({
  SILLY_TAVERN: 'sillytavern',
  TAURI_TAVERN: 'tauritavern',
})

const READY_POLL_INTERVAL_MS = 50
const READY_POLL_TIMEOUT_MS = 7000

function currentWindow() {
  return typeof window === 'undefined' ? undefined : window
}

function readyPromise(value) {
  const candidate = value?.__TAURITAVERN__?.ready ?? value?.__TAURITAVERN_MAIN_READY__
  return candidate && typeof candidate.then === 'function' ? candidate : undefined
}

export function isTauriTavernHost() {
  const value = currentWindow()
  return Boolean(value?.__TAURITAVERN__ || value?.__TAURITAVERN_MAIN_READY__)
}

export function detectHostRuntime() {
  const isTauriTavern = isTauriTavernHost()
  return Object.freeze({
    kind: isTauriTavern ? HOST_KINDS.TAURI_TAVERN : HOST_KINDS.SILLY_TAVERN,
    label: isTauriTavern ? 'TauriTavern' : 'SillyTavern',
    isTauriTavern,
    supportsPopupPairing: !isTauriTavern,
    supportsServerPlugin: !isTauriTavern,
  })
}

export async function waitForHostReady() {
  const value = currentWindow()
  if (!value) throw new Error('酒馆页面尚未准备好')

  if (isTauriTavernHost()) {
    let ready = readyPromise(value)
    if (!ready) {
      // TT exposes its host object before registering the compatibility-ready promise.
      const deadline = Date.now() + READY_POLL_TIMEOUT_MS
      while (!ready && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL_MS))
        ready = readyPromise(value)
      }
    }
    if (!ready) throw new Error('TauriTavern 就绪信号尚未注册，请重新加载扩展')
    await ready
  }

  const host = detectHostRuntime()
  const context = value.SillyTavern?.getContext?.()
  if (!context) throw new Error(`${host.label} 上下文尚未准备好`)
  return { host, context }
}
