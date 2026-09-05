// Allowed origins: the deployed site (SITE_URL) and local dev only.
// This is a private single-user tool, there is no extension origin and no
// public product origin to allow.
const LOCAL_ORIGIN = 'http://localhost:3000'

export function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') || ''
  const siteUrl = Deno.env.get('SITE_URL') || LOCAL_ORIGIN
  const isAllowed = origin === siteUrl || origin === LOCAL_ORIGIN
  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : siteUrl,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }
}
