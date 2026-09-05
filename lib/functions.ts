'use client'

import { supabaseClient } from './supabase'

// Every edge function is POST-only and takes the session access token plus the
// anon key. There are no quotas on this deployment, so there is no 429 branch.
export async function callWatchFn<T>(name: string, body: unknown): Promise<T> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anonKey) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are not set.')
  }

  const { data } = await supabaseClient().auth.getSession()
  const accessToken = data.session?.access_token || ''

  let response: Response
  try {
    response = await fetch(`${url}/functions/v1/${name}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: anonKey,
        Authorization: `Bearer ${accessToken || anonKey}`,
      },
      body: JSON.stringify(body),
    })
  } catch {
    throw new Error('Network error — could not reach the server.')
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new Error(`Service error (${response.status})`)
  }

  const asRecord = (payload ?? {}) as Record<string, unknown>
  const serverError = typeof asRecord.error === 'string' ? asRecord.error : null

  if (!response.ok) throw new Error(serverError || `Service error (${response.status})`)
  if (asRecord.success === false) throw new Error(serverError || 'Request failed.')

  return payload as T
}
