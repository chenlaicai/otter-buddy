const CHANGE_EVENT = 'otter-background-change'
let snapshot: string | null = null

export function readBackgroundSnapshot() {
  return snapshot
}

export function setBackgroundSnapshot(url: string | null) {
  snapshot = url
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

export function subscribeBackgroundPreference(listener: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, listener)
  return () => window.removeEventListener(CHANGE_EVENT, listener)
}
