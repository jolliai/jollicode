/**
 * REDEEM THE ONE-TIME CODE THE CONSENT PAGE HANDED THE CALLBACK, AND REFRESH WHAT IT HANDED BACK.
 *
 * ⚠ THE TOKEN NEVER TOUCHES THE BROWSER. The consent page puts only a single-use code on the
 * callback URL; this POSTs that code server-to-server and the credentials come back in the JSON
 * body. That is what keeps the JWT out of the address bar, browser history and referer logs —
 * Jolli's backend calls it out at `backend/src/router/AuthRouter.ts:305-311` (JOLLI-1270).
 *
 * ⚠ FIELDS ARE VALIDATED ONE AT A TIME, NOT AS ONE STRUCT, AND THAT IS LOAD-BEARING. A credential
 * that is not a string is a failed sign-in; a `baseUrl` that is not a string is simply absent, and
 * the caller falls back to `Brand.gatewayUrl`. `jolli.test.ts` pins both. A single tolerant schema
 * cannot express that split — it would reject the whole response over an auxiliary field and take
 * a perfectly good token down with it.
 *
 * ⚠ THIS FILE STAYS DEPENDENCY-FREE ON PURPOSE. It is ported from Jolli Memory's
 * `cli/src/auth/CliExchange.ts` so both products speak the same wire contract, and the Electron
 * main process imports it; keep them in step if the endpoint changes.
 */
import { isJolliOriginAllowed, parseJolliUrl } from "./origin"

export interface JolliCredentials {
  /**
   * The access token.
   *
   * ⚠ STILL NAMED `token`, THOUGH THE BACKEND NOW CALLS IT `access_token`. Every caller and test in
   * this repo reads `.token`, and renaming it buys nothing: this is the field that authenticates a
   * request either way. The wire name is translated below.
   */
  readonly token: string
  /**
   * Exchanged for a new access token when that one nears expiry. Absent on a backend that predates
   * the triple, which is also what makes `expiresIn` absent — nothing to refresh with, so nothing
   * expires as far as this client is concerned.
   */
  readonly refreshToken?: string
  /**
   * Seconds, as the backend reports it. Deliberately NOT resolved to an absolute time here: the
   * service layer does that against a controllable `Clock`, which is what makes expiry testable.
   */
  readonly expiresIn?: number
  /** The backend's user id, when it reports one. Used as the credential's row id and cache identity. */
  readonly subject?: string
  /** Display only. */
  readonly email?: string
  /**
   * The user's tenant, e.g. `https://acme.jolli.ai`. The gateway lives at `<baseUrl>/api`.
   * Optional because the sign-in origin is the auth hub, not the tenant, and a backend that
   * predates this field simply does not send it — callers fall back to `Brand.gatewayUrl`.
   */
  readonly baseUrl?: string
}

/**
 * Why a refresh failed, which is the only thing the caller actually has to branch on.
 *
 * ⚠ THE DISTINCTION IS DESTRUCTIVE IN ONE DIRECTION. `signed-out` means this credential is finished
 * and the row should go; `unavailable` means we never got an answer and the row must stay. Guessing
 * wrong in the second case signs a student out over a flaky network.
 */
export type JolliRefreshFailure = "signed-out" | "unavailable"

export class JolliRefreshError extends Error {
  constructor(
    readonly kind: JolliRefreshFailure,
    message: string,
  ) {
    super(message)
    this.name = "JolliRefreshError"
  }
}

/**
 * The backend only reads a one-time code out of a short-lived store, so 20s is generous. Without a
 * bound, a half-open socket leaves the callback handler hung with no way for the user to abort.
 */
const EXCHANGE_TIMEOUT_MS = 20_000

export async function exchangeCliCode(jolliUrl: string, code: string): Promise<JolliCredentials> {
  const response = await post(jolliUrl, "/api/auth/cli-exchange", { code }, (detail) => {
    throw new Error(`Couldn't reach Jolli to complete sign-in: ${detail}`)
  })

  // Single-use and TTL-bound, so this is the expected shape of "the user took too long" as well as
  // of a replayed URL. Worth its own message: retrying sign-in fixes it, retrying the code cannot.
  if (response.status === 404) throw new Error("Sign-in code expired or already used. Please sign in again.")
  if (!response.ok) throw new Error(`Sign-in failed (HTTP ${response.status}). Please try again.`)

  const payload = await body(response, (detail) => {
    throw new Error(`Sign-in failed: Jolli returned a malformed response (${detail}).`)
  })

  const credentials = credentialsFrom(payload)
  if (!credentials) throw new Error("Sign-in failed: Jolli's response did not include a token.")
  return credentials
}

/**
 * Trade a refresh token for a fresh access token.
 *
 * ⚠ THE RESPONSE MAY CARRY A NEW REFRESH TOKEN, AND IT MUST BE PERSISTED WHEN IT DOES. The backend
 * rotates on every use, so the one that came in is spent the moment this returns. A backend that
 * does not rotate simply omits it and the caller keeps what it had.
 */
export async function refreshCliToken(jolliUrl: string, refreshToken: string): Promise<JolliCredentials> {
  const response = await post(
    jolliUrl,
    "/api/auth/cli-refresh",
    { grant_type: "refresh_token", refresh_token: refreshToken },
    (detail) => {
      throw new JolliRefreshError("unavailable", `Couldn't reach Jolli to refresh the session: ${detail}`)
    },
  )

  /**
   * ⚠ 4xx MEANS THIS CREDENTIAL, 5xx MEANS THE SERVER — EXCEPT 429, WHICH MEANS "ASK LATER". Rate
   * limiting is the one 4xx that says nothing about the credential, and treating it as a sign-out
   * would log a whole classroom out at once.
   */
  if (!response.ok) {
    const kind: JolliRefreshFailure = response.status === 429 || response.status >= 500 ? "unavailable" : "signed-out"
    throw new JolliRefreshError(kind, `Session refresh failed (HTTP ${response.status}).`)
  }

  const payload = await body(response, (detail) => {
    throw new JolliRefreshError("unavailable", `Session refresh failed: Jolli returned a malformed response (${detail}).`)
  })

  const credentials = credentialsFrom(payload)
  /**
   * ⚠ A 200 WITH NOTHING IN IT KEEPS THE ROW. It is a backend bug rather than a revoked credential,
   * and deleting a student's sign-in over one would be the more expensive mistake.
   */
  if (!credentials) throw new JolliRefreshError("unavailable", "Session refresh failed: Jolli returned no token.")
  return credentials
}

/**
 * ⚠ THE ALLOWLIST IS RE-CHECKED HERE rather than trusted from sign-in start: a long-lived process
 * could be holding a value that was allowlisted when it was read and is not any more, and every
 * request this function makes carries the student's credential.
 */
async function post(jolliUrl: string, path: string, payload: unknown, unreachable: (detail: string) => never) {
  if (!isJolliOriginAllowed(jolliUrl)) throw new Error(`Refusing to exchange against ${jolliUrl}`)
  const parsed = parseJolliUrl(jolliUrl)

  return fetch(new URL(path, parsed.origin), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // The route is mounted on the origin, not under the tenant path, so a path-based deployment
      // names its tenant in a header instead.
      ...(parsed.tenantSlug ? { "x-tenant-slug": parsed.tenantSlug } : {}),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
  }).catch((error) => unreachable(describe(error)))
}

async function body(response: Response, malformed: (detail: string) => never): Promise<unknown> {
  return response.json().catch((error) => malformed(describe(error)))
}

/**
 * ⚠ READ THROUGH `Reflect.get` RATHER THAN NARROWING THE BODY FIRST. A literal `null` is valid JSON
 * and `json()` resolves it, so anything that assumes an object here throws a raw TypeError past
 * every message this file carefully phrases — and asserting a shape onto an `any` body is exactly
 * the unsafe cast the linter objects to.
 */
function field(payload: unknown, key: string) {
  if (payload === null || typeof payload !== "object") return undefined
  return Reflect.get(payload, key)
}

/** Every field the wire may carry, each tolerated independently. Undefined when the token is unusable. */
function credentialsFrom(payload: unknown): JolliCredentials | undefined {
  // `access_token` is the contract going forward; `token` is what a backend that predates it sends.
  const token = text(field(payload, "access_token")) ?? text(field(payload, "token"))
  if (!token) return undefined

  const refreshToken = text(field(payload, "refresh_token"))
  const seconds = field(payload, "expires_in")
  const expiresIn = typeof seconds === "number" && Number.isFinite(seconds) ? seconds : undefined
  const subject = text(field(payload, "sub"))
  const email = text(field(payload, "email"))
  const baseUrl = text(field(payload, "baseUrl"))

  return {
    token,
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresIn !== undefined ? { expiresIn } : {}),
    ...(subject ? { subject } : {}),
    ...(email ? { email } : {}),
    ...(baseUrl ? { baseUrl: baseUrl.replace(/\/+$/, "") } : {}),
  }
}

function text(value: unknown) {
  return typeof value === "string" && value ? value : undefined
}

function describe(error: unknown) {
  if (error instanceof DOMException && error.name === "TimeoutError")
    return `timed out after ${EXCHANGE_TIMEOUT_MS / 1000}s`
  return error instanceof Error ? error.message : String(error)
}
