/**
 * WHERE JOLLI SIGN-IN HAPPENS, AND THE ALLOWLIST THAT BOUNDS IT.
 *
 * ⚠ THE ALLOWLIST IS THE POINT, NOT THE DEFAULT. Sign-in sends a browser to this origin and then
 * redeems a one-time code against it, so a socially-engineered `JOLLI_URL=https://evil.com` would
 * hand that origin the user's credentials before any provider call is involved. Ported from Jolli
 * Memory's `cli/src/core/JolliApiUtils.ts`, which enforces the same list for the same reason.
 *
 * ⚠ `JOLLI_URL` IS DELIBERATELY UNPREFIXED, WHICH MAKES IT THE ONE EXCEPTION IN THIS REPO. Every
 * other override here goes through `flag/flag.ts` as `JOLLICODE_*` (with `OPENCODE_*` as a legacy
 * read-alias). This one keeps Jolli Memory's spelling so a developer pointing one Jolli client at a
 * dev tenant points all of them at it with a single variable.
 */

/** The auth hub. Not a tenant — the user's real tenant is only known after the exchange. */
const DEFAULT_AUTH_ORIGIN = "https://auth.jolli.ai"

const ALLOWED_HOSTS = ["jolli.ai", "jolli.dev", "jolli-local.me"]

export function jolliAuthOrigin() {
  const origin = (process.env["JOLLI_URL"]?.trim() || DEFAULT_AUTH_ORIGIN).replace(/\/+$/, "")
  if (!isJolliOriginAllowed(origin))
    throw new Error(`JOLLI_URL is not an allowed Jolli origin: ${origin}`)
  return origin
}

/** Never throws — callers that only need a yes/no must not have to catch one. */
export function isJolliOriginAllowed(origin: string) {
  if (!URL.canParse(origin)) return false
  const url = new URL(origin)
  // https only: the code exchange carries a credential, and a downgrade would expose it on the wire.
  if (url.protocol !== "https:") return false
  const host = url.hostname.toLowerCase()
  return ALLOWED_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))
}

/**
 * Splits a Jolli URL into the origin every API route is mounted on and the tenant slug a
 * path-based deployment carries in its first path segment (`https://jolli-local.me/dev`).
 * Subdomain deployments have no slug here — their tenant is the host.
 */
export function parseJolliUrl(jolliUrl: string) {
  const url = new URL(jolliUrl)
  const segments = url.pathname.split("/").filter(Boolean)
  return { origin: url.origin, tenantSlug: segments[0] }
}
