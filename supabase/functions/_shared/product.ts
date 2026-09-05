import { getEnv } from './env.ts'
// Deployment-specific product name, interpolated into AI prompts throughout
// this tool (e.g. "a community post about {PRODUCT_NAME}"). Set via the
// PRODUCT_NAME env var; falls back to a generic phrase so prompts still read
// naturally before you've configured your own.
export const PRODUCT_NAME = getEnv('PRODUCT_NAME') ?? 'the product'
