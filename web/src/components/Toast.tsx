import { useEffect, useState } from 'react'

interface ToastState {
  message: string
  type: 'success' | 'error' | 'info'
}

let toastCallback: ((state: ToastState) => void) | null = null

export function showToast(message: string, type: 'success' | 'error' | 'info' = 'info') {
  toastCallback?.({ message, type })
}

export function ToastContainer() {
  const [toast, setToast] = useState<ToastState | null>(null)

  useEffect(() => {
    toastCallback = setToast
    return () => { toastCallback = null }
  }, [])

  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 2500)
      return () => clearTimeout(timer)
    }
  }, [toast])

  if (!toast) return null

  const bgClass = toast.type === 'success'
    ? 'bg-teal-400 text-white'
    : toast.type === 'error'
    ? 'bg-red-400 text-white'
    : 'bg-stone-600 text-white'

  return (
    <div className={`fixed top-14 right-5 px-4 py-2.5 rounded-2xl shadow-otter-lg text-sm font-medium z-[110] ${bgClass}`}>
      {toast.message}
    </div>
  )
}
