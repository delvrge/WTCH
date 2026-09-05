'use client'

import { useEffect } from 'react'

// Cmd+K on Mac, Ctrl+K on Windows/Linux, same binding, browsers report it
// as metaKey vs ctrlKey depending on platform. `onTrigger` fires only for the
// shortcut, not for an ordinary click-to-focus, so callers can tell the two
// apart (e.g. only shortcut-triggered focus should dim the rest of the page).
export function useCmdK(ref: React.RefObject<HTMLInputElement | null>, onTrigger?: () => void) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'k') return
      e.preventDefault()
      ref.current?.focus()
      ref.current?.select()
      onTrigger?.()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [ref, onTrigger])
}
