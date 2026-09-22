/**
 * TALKING TO OUR OWN SIDECAR, WHICH IS NOW THE ONLY THING THAT HOLDS THE CREDENTIAL.
 *
 * ⚠ THE MAIN PROCESS STOPPED BEING A CREDENTIAL STORE, AND THIS MODULE IS WHAT REPLACED IT. Signing
 * in, checking whether anyone is signed in, reading the course gate and signing out are all answers
 * the server already knows, because it reads the database it shares with the bare CLI. Asking it is
 * what keeps one writer for one credential; the alternative — opening that database from Electron —
 * does not even resolve to the same file, because `InstallationChannel` reads a bare global that
 * `electron.vite.config.ts` does not define for the main bundle.
 *
 * ⚠ EVERY CALL IS AUTHENTICATED WITH THE PASSWORD THIS PROCESS GENERATED. The sidecar refuses
 * anything else, which is what keeps a local port from being an open door.
 */
import { Brand } from "@opencode-ai/app/brand"

export interface SidecarAddress {
  readonly hostname: string
  readonly port: number
  readonly password: string
}

/**
 * Short enough that a wedged server shows up as a failure rather than a hang — every caller here is
 * behind a screen somebody is looking at. The sign-in callback is the one exception and passes its
 * own bound, because it is waiting on a human in a browser.
 */
const DEFAULT_TIMEOUT_MS = 10_000

export type SidecarCall = <T>(
  path: string,
  init?: RequestInit & { timeoutMs?: number },
) => Promise<T>

export function sidecarCall(address: SidecarAddress): SidecarCall {
  const origin = `http://${address.hostname}:${address.port}`
  const authorization = `Basic ${Buffer.from(`${Brand.short}:${address.password}`).toString("base64")}`

  return async <T>(path: string, init?: RequestInit & { timeoutMs?: number }) => {
    // Built rather than spread: `HeadersInit` may be an array or a `Headers`, and spreading either
    // into an object produces indices instead of headers.
    const headers = new Headers(init?.headers)
    if (!headers.has("content-type")) headers.set("content-type", "application/json")
    // Always ours: this is what stops a local port from being an open door.
    headers.set("authorization", authorization)

    const response = await fetch(new URL(path, origin), {
      ...init,
      headers,
      signal: AbortSignal.timeout(init?.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${path} failed (HTTP ${response.status})`)
    // Some of these routes answer with a bare `true` and some with nothing at all; neither is worth
    // a parse error at the call site.
    const body: unknown = await response.json().catch(() => undefined)
    /**
     * ⚠ THE TYPE PARAMETER IS A CONVENIENCE, NOT A GUARANTEE — nothing here validates the shape, so
     * every caller in this package treats what comes back as possibly-absent and narrows it itself
     * (`providers?.connected?.includes(...)`, `catalog.status !== "ok"`). Asserted rather than
     * returned as `unknown` only because the alternative pushes the same assertion to three call
     * sites without adding a single check.
     */
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    return body as T
  }
}
