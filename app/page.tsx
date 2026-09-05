'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { errorMessage, supabaseClient } from '@/lib/supabase'

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [mode, setMode] = useState<'sign-in' | 'forgot' | 'sign-up'>('sign-in')
  const [resetSent, setResetSent] = useState(false)
  const [signupSent, setSignupSent] = useState(false)

  useEffect(() => {
    let active = true
    try {
      supabaseClient()
        .auth.getSession()
        .then(({ data }) => {
          if (active && data.session) router.replace('/dashboard')
        })
    } catch {
      // Missing env vars surface on submit instead.
    }
    return () => {
      active = false
    }
  }, [router])

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setError('')
    setBusy(true)
    try {
      const { error: signInError } = await supabaseClient().auth.signInWithPassword({
        email: email.trim(),
        password,
      })
      if (signInError) throw new Error(signInError.message)
      router.replace('/dashboard')
    } catch (err) {
      setError(errorMessage(err, 'Sign-in failed.'))
      setBusy(false)
    }
  }

  async function submitForgot(event: React.FormEvent) {
    event.preventDefault()
    setError('')
    setBusy(true)
    try {
      const { error: resetError } = await supabaseClient().auth.resetPasswordForEmail(email.trim(), {
        redirectTo: `${window.location.origin}/reset-password`,
      })
      if (resetError) throw new Error(resetError.message)
      setResetSent(true)
    } catch (err) {
      setError(errorMessage(err, 'Could not send reset email.'))
    } finally {
      setBusy(false)
    }
  }

  async function submitSignUp(event: React.FormEvent) {
    event.preventDefault()
    setError('')
    setBusy(true)
    try {
      const { error: signUpError } = await supabaseClient().auth.signUp({
        email: email.trim(),
        password,
        options: { emailRedirectTo: `${window.location.origin}/dashboard` },
      })
      if (signUpError) throw new Error(signUpError.message)
      setSignupSent(true)
    } catch (err) {
      setError(errorMessage(err, 'Could not sign up.'))
    } finally {
      setBusy(false)
    }
  }

  if (mode === 'sign-up') {
    return (
      <div className="login">
        {signupSent ? (
          <p className="meta">Check {email} to confirm your account, then sign in.</p>
        ) : (
          <form onSubmit={submitSignUp}>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              aria-label="Email"
              placeholder="Email"
              autoComplete="username"
              required
            />
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              aria-label="Password"
              placeholder="Password"
              autoComplete="new-password"
              minLength={6}
              required
            />
            <button type="submit" className="btn primary" disabled={busy}>
              {busy ? 'Creating account' : 'Create account'}
            </button>
            {error ? <p className="error">{error}</p> : null}
          </form>
        )}
        <button
          type="button"
          className="btn quiet"
          onClick={() => {
            setMode('sign-in')
            setError('')
            setSignupSent(false)
          }}
        >
          Back to sign in
        </button>
      </div>
    )
  }

  if (mode === 'forgot') {
    return (
      <div className="login">
        {resetSent ? (
          <p className="meta">Check {email} for a password reset link.</p>
        ) : (
          <form onSubmit={submitForgot}>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              aria-label="Email"
              placeholder="Email"
              autoComplete="username"
              required
            />
            <button type="submit" className="btn primary" disabled={busy}>
              {busy ? 'Sending' : 'Send reset link'}
            </button>
            {error ? <p className="error">{error}</p> : null}
          </form>
        )}
        <button
          type="button"
          className="btn quiet"
          onClick={() => {
            setMode('sign-in')
            setError('')
            setResetSent(false)
          }}
        >
          Back to sign in
        </button>
      </div>
    )
  }

  return (
    <div className="login">
      <form onSubmit={submit}>
        <input
          type="email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          aria-label="Email"
          placeholder="Email"
          autoComplete="username"
          required
        />
        <input
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          aria-label="Password"
          placeholder="Password"
          autoComplete="current-password"
          required
        />
        <button type="submit" className="btn primary" disabled={busy}>
          Sign in
        </button>
        <div className="row">
          <button type="button" className="btn quiet" onClick={() => setMode('forgot')}>
            Forgot password?
          </button>
          <button type="button" className="btn quiet" onClick={() => setMode('sign-up')}>
            Create an account
          </button>
        </div>
        {error ? <p className="error">{error}</p> : null}
      </form>
    </div>
  )
}
