/**
 * REDEEM THE ONE-TIME CODE THE CONSENT PAGE HANDED THE CALLBACK.
 *
 * ⚠ THE TOKEN NEVER TOUCHES THE BROWSER. The consent page puts only a single-use code on the
 * callback URL; this POSTs that code server-to-server and the credentials come back in the JSON
 * body. That is what keeps the JWT out of the address bar, browser history and referer logs —
 * Jolli's backend calls it out at `backend/src/router/AuthRouter.ts:305-311` (JOLLI-1270).
 *
 * Ported from Jolli Memory's `cli/src/auth/CliExchange.ts` so both products speak the same wire
 * contract; keep them in step if the endpoint changes.
 */
import { isJolliOriginAllowed, parseJolliUrl } from "./origin"

export interface JolliCredentials {
  /** Long-lived CLI JWT. This is what authenticates model calls through the gateway. */
  readonly token: string
  /**
   * The user's tenant, e.g. `https://acme.jolli.ai`. The gateway lives at `<baseUrl>/api`.
   * Optional because the sign-in origin is the auth hub, not the tenant, and a backend that
   * predates this field simply does not send it — callers fall back to `Brand.gatewayUrl`.
   */
  readonly baseUrl?: string
}

/**
 * The backend only reads a one-time code out of a short-lived store, so 20s is generous. Without a
 * bound, a half-open socket leaves the callback handler hung with no way for the user to abort.
 */
const EXCHANGE_TIMEOUT_MS = 20_000

export async function exchangeCliCode(jolliUrl: string, code: string): Promise<JolliCredentials> {
  // Re-checked here rather than trusted from sign-in start: a long-lived process could be holding a
  // value that was allowlisted when it was read and is not any more.
  if (!isJolliOriginAllowed(jolliUrl)) throw new Error(`Refusing to exchange against ${jolliUrl}`)
  const parsed = parseJolliUrl(jolliUrl)

  const response = await fetch(new URL("/api/auth/cli-exchange", parsed.origin), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // The route is mounted on the origin, not under the tenant path, so a path-based deployment
      // names its tenant in a header instead.
      ...(parsed.tenantSlug ? { "x-tenant-slug": parsed.tenantSlug } : {}),
    },
    body: JSON.stringify({ code }),
    signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
  }).catch((error) => {
    throw new Error(`Couldn't reach Jolli to complete sign-in: ${describe(error)}`)
  })

  // Single-use and TTL-bound, so this is the expected shape of "the user took too long" as well as
  // of a replayed URL. Worth its own message: retrying sign-in fixes it, retrying the code cannot.
  if (response.status === 404) throw new Error("Sign-in code expired or already used. Please sign in again.")
  if (!response.ok) throw new Error(`Sign-in failed (HTTP ${response.status}). Please try again.`)

  const payload = await response
    .json()
    .catch((error) => {
      throw new Error(`Sign-in failed: Jolli returned a malformed response (${describe(error)}).`)
    })
    // `?? {}` because a literal `null` body is valid JSON: `json()` resolves it, and reading a
    // property off it below would throw a raw TypeError past every message this function phrases.
    // A body with nothing in it is the same failure as a body with no token in it.
    .then((value) => (value ?? {}) as { token?: unknown; baseUrl?: unknown })

  if (typeof payload.token !== "string" || !payload.token)
    throw new Error("Sign-in failed: Jolli's response did not include a token.")

  return {
    token: payload.token,
    ...(typeof payload.baseUrl === "string" && payload.baseUrl
      ? { baseUrl: payload.baseUrl.replace(/\/+$/, "") }
      : {}),
  }
}

function describe(error: unknown) {
  if (error instanceof DOMException && error.name === "TimeoutError")
    return `timed out after ${EXCHANGE_TIMEOUT_MS / 1000}s`
  return error instanceof Error ? error.message : String(error)
}
