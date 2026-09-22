/**
 * THE JOLLI BROWSER SIGN-IN, SHARED BY EVERY SURFACE THAT HAS A NODE PROCESS.
 *
 * ⚠ ONE IMPLEMENTATION, NOT ONE PER SURFACE. The bare CLI/TUI reaches this through its provider
 * auth plugin and the desktop app reaches it from the Electron main process; both are Node, both
 * bind their own loopback port, and both redeem the same one-time code. Anything that differs
 * between them — how the browser gets opened, where the credentials are stored — is the caller's.
 *
 * ⚠ LOOPBACK IS THE ONLY CALLBACK JOLLI ACCEPTS. `isAllowedCliCallback` in the Jolli backend admits
 * `http://127.0.0.1:<port>/callback` and nothing else; the custom-scheme branch was deliberately
 * removed, because a custom scheme is claimable by any application on the machine. Do not "improve"
 * this into a `jollicode://` deep link without changing that allowlist first.
 *
 * ⚠ IT BINDS ON THE MACHINE THE CALLER RUNS ON, WHICH IS NOT ALWAYS THE USER'S. A provider plugin
 * executes inside the opencode server, so a remote `opencode serve` would bind loopback on the
 * server and the user's browser could never reach it. Jolli Code targets local use; a remote
 * surface needs a device-code flow instead, which `auth.jolli.ai` does not offer today.
 *
 * Modelled on Jolli Memory's `cli/src/auth/Login.ts` so the two products stay wire-compatible.
 */
import { randomBytes, timingSafeEqual } from "node:crypto"
import { createServer, type Server, type ServerResponse } from "node:http"
import { Brand } from "../brand"
import { OauthCallbackPage } from "../oauth/page"
import { exchangeCliCode, type JolliCredentials } from "./exchange"
import { jolliAuthOrigin } from "./origin"

/** Fixed by the backend's allowlist — the callback path is matched literally, not configured. */
const CALLBACK_PATH = "/callback"

/**
 * How long a browser sign-in may stay open before the attempt gives up.
 *
 * Generous enough for a slow institutional SSO with an MFA prompt in it, and bounded because the
 * alternative is unbounded: a user who closes the tab leaves the loopback server bound and both
 * callers — the desktop `signIn()` and the plugin's `callback()` — awaiting a promise that has
 * nothing left to settle it.
 */
const LOGIN_TIMEOUT_MS = 5 * 60_000

/**
 * The rejection a cancelled attempt produces.
 *
 * ⚠ ITS OWN TYPE SO CALLERS CAN TELL "THE STUDENT GAVE UP" FROM "SIGN-IN FAILED". Every other
 * rejection here is something to show them; this one is the thing they just asked for, and
 * reporting it back as an error would put "Sign-in was cancelled" on a screen they cancelled to
 * get away from.
 */
export class CancelledSignInError extends Error {
  readonly cancelled = true
  constructor() {
    super("Sign-in was cancelled.")
    this.name = "CancelledSignInError"
  }
}

export function isCancelledSignIn(error: unknown) {
  return error instanceof CancelledSignInError
}

export interface JolliLoginAttempt {
  /** The Jolli sign-in page to open. How it gets opened is the caller's business. */
  readonly url: string
  /** Resolves once the browser has come back and the one-time code has been redeemed. */
  wait(): Promise<JolliCredentials>
  /**
   * Give up on this attempt now: close the loopback server and reject {@link wait}.
   *
   * ⚠ IT EXISTS BECAUSE CLOSING THE BROWSER TAB IS INVISIBLE FROM HERE. Nothing reaches this
   * server when a student abandons the page, so without an explicit cancel the only thing that
   * ends the attempt is {@link LOGIN_TIMEOUT_MS} — five minutes of a bound port and a UI that
   * cannot be dismissed.
   *
   * ⚠ AND IT MATTERS THAT THE SERVER ACTUALLY CLOSES, not just that the caller stops awaiting. A
   * still-listening callback would redeem the code and hand back credentials for a sign-in the
   * student has already walked away from.
   *
   * Idempotent: rejecting a settled promise is a no-op, and closing a closed server is harmless.
   */
  cancel(): void
}

/**
 * Binds a loopback callback server and returns the sign-in URL pointing at it.
 *
 * Port 0 so the OS assigns a free one — a fixed port collides with a second window, another
 * editor, or a previous attempt that has not finished closing.
 *
 * Deliberately asks for no API key: `generate_api_key` would mint a `sk-jol-` key whose name is an
 * idempotency key shared with Jolli Memory's CLI, and signing in here would delete that product's
 * key on the same machine. Jolli Code authenticates with the JWT instead.
 */
export async function startJolliLogin(input: { clientVersion: string }): Promise<JolliLoginAttempt> {
  const origin = jolliAuthOrigin()
  // 256-bit CSRF nonce per RFC 6749 §10.12: sent on the login URL, echoed back on the callback.
  // A mismatch means the callback did not originate from the flow we just opened.
  const state = randomBytes(32).toString("hex")

  let resolve!: (credentials: JolliCredentials) => void
  let reject!: (error: Error) => void
  const settled = new Promise<JolliCredentials>((onValue, onError) => {
    resolve = onValue
    reject = onError
  })

  const server = createServer(async (req, res) => {
    // The authority is irrelevant — the request already reached this socket — but `URL` needs one.
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404)
      res.end("Not found")
      return
    }

    const outcome = await readCallback(url)
    // Tear down only once the page has actually flushed: `closeAllConnections()` destroys this very
    // socket, so closing first replaces the branded result page with a connection error.
    if (outcome instanceof Error) {
      respond(res, 400, OauthCallbackPage.error(outcome.message), () => close(server))
      reject(outcome)
      return
    }
    respond(res, 200, OauthCallbackPage.success(), () => close(server))
    resolve(outcome)
  })

  await new Promise<void>((listening, failed) => {
    server.once("error", failed)
    server.listen(0, "127.0.0.1", listening)
  })

  // Unref'd so a pending sign-in never holds a CLI process open, and cleared on every outcome —
  // including this one, since rejecting an already-settled promise is a no-op.
  const expiry = setTimeout(() => {
    close(server)
    reject(new Error("Sign-in timed out. Please try again."))
  }, LOGIN_TIMEOUT_MS)
  expiry.unref()
  // Attaching here is also what marks `settled` as handled: a caller that never calls `wait()` would
  // otherwise turn the timeout into an unhandled rejection.
  settled.finally(() => clearTimeout(expiry)).catch(() => undefined)

  const address = server.address()
  const port = typeof address === "object" && address !== null ? address.port : 0
  const query = new URLSearchParams({
    cli_callback: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
    state,
    // `Brand.bin` is the same literal the backend's signup-source allowlist carries, so the wire
    // value and the product name cannot drift apart.
    client: Brand.bin,
    client_version: input.clientVersion,
  })

  return {
    url: `${origin}/login?${query}`,
    wait: () => settled,
    cancel() {
      close(server)
      reject(new CancelledSignInError())
    },
  }

  /** Credentials, or the reason this callback cannot produce any. Never throws. */
  async function readCallback(url: URL): Promise<JolliCredentials | Error> {
    const failure = url.searchParams.get("error")
    if (failure) return new Error(describeCallbackError(failure))

    const code = url.searchParams.get("code")
    if (!code) return new Error("The sign-in callback carried no authorization code.")

    if (!statesMatch(url.searchParams.get("state"), state))
      return new Error("The sign-in callback failed its security check (state mismatch). Please try again.")

    return exchangeCliCode(origin, code).catch((error) =>
      error instanceof Error ? error : new Error(String(error)),
    )
  }
}

/**
 * Constant-time comparison. A 256-bit nonce makes a timing attack infeasible anyway, but this costs
 * nothing and keeps the comparison correct by construction.
 *
 * Lengths are compared on the encoded bytes rather than the strings: `String.length` counts UTF-16
 * code units while `Buffer.from` defaults to UTF-8, so an attacker-supplied non-ASCII state of
 * matching character length would otherwise crash `timingSafeEqual` with a RangeError.
 */
function statesMatch(received: string | null, expected: string) {
  if (received === null) return false
  const a = Buffer.from(received)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** Jolli's callback error codes, as messages a student can act on. */
function describeCallbackError(code: string) {
  const messages: Record<string, string> = {
    oauth_failed: "Sign-in failed. Please try again.",
    session_missing: "Your session expired before sign-in finished. Please try again.",
    invalid_provider: "That sign-in provider isn't available.",
    auth_fetch_failed: "Jolli couldn't read your account details from the sign-in provider.",
    no_verified_emails: "Your account has no verified email address.",
    server_error: "Jolli hit an unexpected error. Please try again later.",
    failed_to_get_token: "Jolli couldn't issue your credentials. Please try signing in again.",
    user_denied: "Sign-in was cancelled.",
    invalid_callback: "Jolli rejected the sign-in callback. Please try again.",
  }
  return messages[code] ?? `Sign-in failed: ${code}`
}

function respond(res: ServerResponse, status: number, html: string, flushed: () => void) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" })
  res.end(html, flushed)
}

/** Destroys keep-alive sockets too, so the process is free to exit straight after sign-in. */
function close(server: Server) {
  server.closeAllConnections()
  server.close()
}
