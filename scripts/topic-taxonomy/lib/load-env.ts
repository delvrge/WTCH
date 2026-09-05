// Side-effect import: loads the repo root .env.local into process.env so
// the topic-taxonomy scripts don't need SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY/
// GEMINI_API_KEY passed inline on every invocation. Uses Node's built-in
// loader (no dotenv dependency needed on Node 20.6+). Doesn't override
// vars already set in the shell environment.

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ENV_PATH = join(__dirname, '..', '..', '..', '.env.local')

try {
  process.loadEnvFile(ENV_PATH)
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
}
