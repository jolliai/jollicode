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
  /** Desktop bundle id (reverse-DNS). prod uses this; dev/beta append .dev/.beta. */
  appId: "ai.jolli.desktop",
  /** Base URL of the Jolli gateway (multi-protocol LLM proxy). */
  gatewayUrl: "https://api.jolli.ai",
  /** Canonical env-var prefix. OPENCODE_ is a deprecated read-alias. */
  envPrefix: "JOLLICODE_",
  /**
   * Build the runtime HTTP User-Agent from the brand prefix plus caller-supplied
   * parts, e.g. `Brand.userAgent(version)` -> "jollicode/1.2.3" and
   * `Brand.userAgent(channel, version, client)` -> "jollicode/latest/1.2.3/cli".
   *
   * Callers pass version/channel/client as arguments so Brand stays
   * dependency-free (it must NOT import InstallationVersion/Channel itself).
   */
  userAgent(...parts: string[]): string {
    return [Brand.bin, ...parts.filter(Boolean)].join("/")
  },
} as const
