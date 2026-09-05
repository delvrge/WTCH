'use client'

import { useEffect, useState } from 'react'

// Mac shows the ⌘ glyph, everyone else gets the literal "Ctrl" label ,
// matches how the OS itself denotes the shortcut in its own menus.
export default function KbdHint({ letter }: { letter: string }) {
  const [mac, setMac] = useState(true)

  useEffect(() => {
    setMac(/mac/i.test(navigator.userAgent))
  }, [])

  return <span className="kbd-hint">{mac ? `⌘${letter}` : `Ctrl ${letter}`}</span>
}
