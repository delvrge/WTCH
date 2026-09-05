'use client'

import { useEffect, useState } from 'react'
import { errorMessage, supabaseClient } from './supabase'

export type SessionStatus = 'loading' | 'signed-in' | 'signed-out'

export interface SessionState {
  status: SessionStatus
  userId: string | null
  error: string
}

export function useSession(): SessionState {
  const [state, setState] = useState<SessionState>({ status: 'loading', userId: null, error: '' })

  useEffect(() => {
    let active = true
    let unsubscribe: (() => void) | null = null

    try {
      const supabase = supabaseClient()
      supabase.auth.getSession().then(({ data }) => {
        if (!active) return
        const user = data.session?.user
        setState({
          status: user ? 'signed-in' : 'signed-out',
          userId: user?.id ?? null,
          error: '',
        })
      })
      const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
        if (!active) return
        setState({
          status: session?.user ? 'signed-in' : 'signed-out',
          userId: session?.user?.id ?? null,
          error: '',
        })
      })
      unsubscribe = () => sub.subscription.unsubscribe()
    } catch (err) {
      setState({ status: 'signed-out', userId: null, error: errorMessage(err, 'Sign-in unavailable.') })
    }

    return () => {
      active = false
      if (unsubscribe) unsubscribe()
    }
  }, [])

  return state
}
