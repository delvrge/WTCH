// Cross-runtime env accessor.
//
// These _shared modules run under two different runtimes: Deno (the edge
// functions themselves) AND Node/tsx (scripts/ imports several of them
// directly, see tsconfig.json's comment on allowImportingTsExtensions).
// `Deno.env` doesn't exist under Node, and `process.env` isn't populated the
// same way under Deno, so any _shared module that needs a config value at
// module-load time must go through this instead of touching either global
// directly.
declare const Deno: { env: { get(name: string): string | undefined } } | undefined

export function getEnv(name: string): string | undefined {
  if (typeof Deno !== 'undefined') return Deno.env.get(name)
  if (typeof process !== 'undefined' && process.env) return process.env[name]
  return undefined
}
