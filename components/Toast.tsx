'use client'

import { useEffect, useState } from 'react'
import styles from './Toast.module.css'

// Small imperative toast system, deliberately not hardcoded to any one
// screen: `toast.success(...)` / `toast.error(...)` can be called from
// anywhere (event handlers, async functions, outside React entirely), and
// any screen that wants them rendered mounts <Toaster /> once. State lives
// in a module-level queue shared by every mounted <Toaster />, so it works
// the same whether one screen mounts it or several.

export type ToastVariant = 'success' | 'error'

interface ToastItem {
  id: number
  message: string
  variant: ToastVariant
  leaving: boolean
}

type Listener = (items: ToastItem[]) => void

const DEFAULT_DURATION_MS = 4500
const EXIT_MS = 160

let items: ToastItem[] = []
let nextId = 0
const listeners = new Set<Listener>()
const timers = new Map<number, ReturnType<typeof setTimeout>>()

function emit() {
  listeners.forEach(listen => listen(items))
}

function clearTimer(id: number) {
  const timer = timers.get(id)
  if (timer) {
    clearTimeout(timer)
    timers.delete(id)
  }
}

/** Starts the exit animation, then drops the toast once it's had time to play. */
function dismiss(id: number) {
  clearTimer(id)
  items = items.map(item => (item.id === id ? { ...item, leaving: true } : item))
  emit()
  setTimeout(() => {
    items = items.filter(item => item.id !== id)
    emit()
  }, EXIT_MS)
}

function push(message: string, variant: ToastVariant, durationMs: number) {
  const id = nextId++
  items = [...items, { id, message, variant, leaving: false }]
  emit()
  timers.set(id, setTimeout(() => dismiss(id), durationMs))
}

export const toast = {
  success: (message: string, durationMs = DEFAULT_DURATION_MS) => push(message, 'success', durationMs),
  error: (message: string, durationMs = DEFAULT_DURATION_MS) => push(message, 'error', durationMs),
}

/** Mount once per screen that wants toasts to render (e.g. near the top of
 * a page's returned JSX). Position is fixed, so placement in the tree
 * doesn't affect layout. */
export function Toaster() {
  const [visible, setVisible] = useState<ToastItem[]>(items)

  useEffect(() => {
    listeners.add(setVisible)
    return () => {
      listeners.delete(setVisible)
    }
  }, [])

  if (!visible.length) return null

  return (
    <div className={styles.viewport} aria-label="Notifications">
      {visible.map(item => (
        <div
          key={item.id}
          className={`${styles.toast} ${item.variant === 'error' ? styles.error : styles.success} ${item.leaving ? styles.leaving : ''}`}
          role={item.variant === 'error' ? 'alert' : 'status'}
          aria-live={item.variant === 'error' ? 'assertive' : 'polite'}
        >
          <span className={styles.dot} aria-hidden="true" />
          <span className={styles.message}>{item.message}</span>
          <button type="button" className={styles.dismiss} onClick={() => dismiss(item.id)} aria-label="Dismiss notification">
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
