'use client'

import { useEffect, useState } from 'react'

type Theme = 'dark' | 'light'

export const THEME_KEY = 'wtch-theme'

/** Kept in sync with the inline pre-paint script in app/layout.tsx. */
function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
}

export default function ThemeToggle() {
  // Rendered on the server too, so it starts at the default and is corrected on
  // mount. Only the icon fill depends on it, so there is nothing to flash.
  const [theme, setTheme] = useState<Theme>('dark')

  useEffect(() => {
    setTheme(currentTheme())
  }, [])

  function toggle() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark'
    document.documentElement.dataset.theme = next
    try {
      localStorage.setItem(THEME_KEY, next)
    } catch {
      // Private mode with storage disabled: the theme still applies for this page.
    }
    setTheme(next)
  }

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={toggle}
      aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
      title={theme === 'dark' ? 'Light' : 'Dark'}
    >
      {/* Half-filled circle: the filled side is the theme you would switch to. */}
      <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.25" />
        <path
          d={theme === 'dark' ? 'M8 1.5 A6.5 6.5 0 0 1 8 14.5 Z' : 'M8 1.5 A6.5 6.5 0 0 0 8 14.5 Z'}
          fill="currentColor"
        />
      </svg>
    </button>
  )
}
