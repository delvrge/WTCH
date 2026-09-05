'use client'

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Built lazily rather than at module scope: the pages are client components
// that still get prerendered at build time, and createClient throws when the
// env vars are absent. Nothing calls this during render — only effects and
// event handlers do.
let client: SupabaseClient | null = null

export function supabaseClient(): SupabaseClient {
  if (client) return client
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anonKey) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are not set.')
  }
  client = createClient(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  })
  return client
}

export function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message
  if (typeof err === 'string' && err) return err
  return fallback
}

// PostgREST (PGRST301) rejects a request when the JWT's `iat` claim looks
// like it's from the future relative to the server's own clock. This is a
// transient clock-skew condition on Supabase's side, not something this app
// causes or can fix directly — but a session refresh mints a fresh token
// with a new `iat`, which usually clears it on the next try.
export function isJwtClockSkewError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  return /issued at future/i.test(message)
}
