/**
 * Re-export of the product identity from core, so packages that already depend on `@opencode-ai/app`
 * (e.g. the desktop main process) can consume the single source of truth without taking a direct
 * dependency on core. See `@opencode-ai/core/brand` for the canonical definition.
 */
export { Brand } from "@opencode-ai/core/brand"
