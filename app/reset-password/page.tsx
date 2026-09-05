'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { errorMessage } from '@/lib/supabase'

// Supabase's recovery link lands here with the session encoded in the URL
// hash. The app-wide client (lib/supabase.ts) has detectSessionInUrl off,
// so this page builds its own, short-lived client with it on to pick up
// that session, never persisted or reused elsewhere.
export default function ResetPasswordPage() {
  const router = useRouter()
  const [client, setClient] = useState<SupabaseClient | null>(null)
  const [ready, setReady] = useState(false)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  useEffect(() => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    if (!url || !anonKey) {
      setError('NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are not set.')
      return
    }
    const c = createClient(url, anonKey, {
      auth: { persistSession: false, detectSessionInUrl: true },
    })
    setClient(c)

    const { data: sub } = c.auth.onAuthStateChange(event => {
      if (event === 'PASSWORD_RECOVERY') setReady(true)
    })
    c.auth.getSession().then(({ data }) => {
      if (data.session) setReady(true)
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!client) return
    setError('')
    setBusy(true)
    try {
      const { error: updateError } = await client.auth.updateUser({ password })
      if (updateError) throw new Error(updateError.message)
      setDone(true)
      setTimeout(() => router.replace('/'), 1500)
    } catch (err) {
      setError(errorMessage(err, 'Could not update password.'))
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <div className="login">
        <p className="meta">Password updated. Redirecting to sign in…</p>
      </div>
    )
  }

  if (!ready) {
    return (
      <div className="login">
        <p className="meta">
          <span className="spinner" /> Verifying reset link…
        </p>
        {error ? <p className="error">{error}</p> : null}
      </div>
    )
  }

  return (
    <div className="login">
      <form onSubmit={submit}>
        <input
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          aria-label="New password"
          placeholder="New password"
          autoComplete="new-password"
          minLength={6}
          required
        />
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? 'Saving' : 'Set new password'}
        </button>
        {error ? <p className="error">{error}</p> : null}
      </form>
    </div>
  )
}
