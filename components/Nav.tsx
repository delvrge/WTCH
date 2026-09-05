'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { supabaseClient } from '@/lib/supabase'
import Bell from './Bell'
import ThemeToggle from './ThemeToggle'

// /watches is hidden from nav (not deleted) — the operator isn't using
// it standalone; see the Watches+Gaps "knowledge gap" idea in the status
// doc. The page and its data still work if linked to directly.
const LINKS: { href: string; label: string }[] = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/library', label: 'Library' },
  { href: '/context', label: 'Context' },
  { href: '/replies', label: 'Replies' },
]

export default function Nav() {
  const pathname = usePathname()
  const router = useRouter()

  async function signOut() {
    try {
      await supabaseClient().auth.signOut()
    } catch {
      // Falls through to the redirect either way.
    }
    router.replace('/')
  }

  return (
    <nav className="nav">
      <span className="nav-logo" title="Watchtower — Community Manager copilot">
        Watchtower
      </span>
      <div className="nav-links">
        {LINKS.map(link => (
          <Link
            key={link.href}
            href={link.href}
            className={pathname === link.href || pathname.startsWith(`${link.href}/`) ? 'active' : ''}
          >
            {link.label}
          </Link>
        ))}
      </div>
      <div className="nav-right">
        <Bell />
        <ThemeToggle />
        <button type="button" className="btn quiet" onClick={signOut}>
          Sign out
        </button>
      </div>
    </nav>
  )
}
