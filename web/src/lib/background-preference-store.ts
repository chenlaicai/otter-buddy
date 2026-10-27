export const BACKGROUND_STORAGE_KEY = 'otter-background-image-v1'
const CHANGE_EVENT = 'otter-background-change'

export function readBackgroundSnapshot() {
  try { return localStorage.getItem(BACKGROUND_STORAGE_KEY) } catch { return null }
}

export function notifyBackgroundPreferenceChanged() {
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

export function subscribeBackgroundPreference(listener: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, listener)
  return () => window.removeEventListener(CHANGE_EVENT, listener)
}
