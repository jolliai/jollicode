/**
 * Single source of truth for Jolli Code product identity.
 * Dependency-free on purpose: safe to import from anywhere in the monorepo,
 * including modules that run at import time (e.g. global.ts).
 */
export const Brand = {
  /** User-facing product/app name. */
  name: "Jolli Code",
  /** Command / executable name. */
  bin: "jollicode",
  /** Published npm package. */
  npm: "@jolli.ai/jollicode",
  /** Short slug: XDG data-dir segment, provider id. */
  short: "jolli",
  tagline: "AI coding agent for learning",
  url: "https://jolli.ai",
  /** GitHub org for releases / upgrade / taps. */
  org: "jolliai",
  /** Desktop URL scheme: jollicode://. */
  protocol: "jollicode",
  /** Base URL of the Jolli gateway (multi-protocol LLM proxy). */
  gatewayUrl: "https://api.jolli.ai",
  /** Canonical env-var prefix. OPENCODE_ is a deprecated read-alias. */
  envPrefix: "JOLLICODE_",
} as const
