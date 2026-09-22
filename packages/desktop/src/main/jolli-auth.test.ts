import { describe, expect, mock, test } from "bun:test"
import { Brand } from "@opencode-ai/app/brand"
import { JOLLI_PROVIDER_IDS } from "@opencode-ai/core/jolli/gateway-config"

/**
 * ⚠ WHAT IS WORTH TESTING HERE CHANGED COMPLETELY, AND THE ABSENCES ARE THE POINT. This module used
 * to hold a credential: the old tests asserted that the token was ciphertext on disk and that an
 * unencryptable machine kept it in memory instead. It holds nothing now — the sidecar owns the
 * sign-in and the shared database owns the credential — so what is left to pin is the sequence of
 * calls it makes, and that the browser URL comes from the server rather than from here.
 */
const opened: string[] = []
const raised = { restored: 0, shown: 0, focused: 0 }

mock.module("./windows", () => ({
  openExternalURL: (url: string) => opened.push(url),
  getLastFocusedWindow: () => ({
    isMinimized: () => true,
    restore: () => raised.restored++,
    show: () => raised.shown++,
    focus: () => raised.focused++,
  }),
}))

/**
 * ⚠ THE ELECTRON MOCK IS A SUPERSET OF WHAT THIS FILE NEEDS, AND DELIBERATELY IDENTICAL TO THE ONE
 * IN THE OTHER MAIN-PROCESS TEST. `mock.module` is process-wide in bun and last-writer-wins, so two
 * partial mocks of the same module break whichever file loads second.
 */
const app = { getPath: () => "/tmp", setPath: () => {}, getVersion: () => "9.9.9", focus: () => {} }

mock.module("electron", () => ({ default: { app }, app, utilityProcess: {}, crashReporter: {}, netLog: {}, shell: {} }))

// Only `write` is reached from here, but the real module is inert until `initLogging()` runs, so
// replacing it wholesale is what would break the files that import the rest of it.
mock.module("./logging", () => ({
  write: () => {},
  getLogger: () => ({ warn: () => {}, error: () => {}, log: () => {} }),
}))

const { isSignedIn, refreshInstance, signIn, signOut } = await import("./jolli-auth")

type Seen = { path: string; method: string; body?: unknown; timeoutMs?: number }

/** Records what the main process asked the sidecar for, and answers each route in turn. */
function stubSidecar(answers: Record<string, unknown> = {}) {
  const seen: Seen[] = []
  // Asserted because a stub has no business carrying the real signature's overloads.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  const call = (async (path: string, init?: RequestInit & { timeoutMs?: number }) => {
    seen.push({
      path,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      ...(init?.timeoutMs !== undefined ? { timeoutMs: init.timeoutMs } : {}),
    })
    return answers[path]
  }) as unknown as Parameters<typeof signIn>[0]
  return { call, seen }
}

describe("signIn", () => {
  test("asks the server to start the flow, opens what it hands back, then waits for the callback", async () => {
    const { call, seen } = stubSidecar({ "/provider/jolli/oauth/authorize": { url: "https://auth.jolli.ai/cli?x=1" } })

    await signIn(call)

    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([
      "POST /provider/jolli/oauth/authorize",
      "POST /provider/jolli/oauth/callback",
    ])
    /**
     * ⚠ THE URL COMES FROM THE SERVER, NOT FROM HERE, and the plugin deliberately does not open it
     * itself — `authorize` runs inside a server that is not always the machine the user is at.
     */
    expect(opened).toContain("https://auth.jolli.ai/cli?x=1")
    // The callback waits on a human in a browser, so it cannot share the ten-second default.
    expect(seen.at(1)?.timeoutMs).toBeGreaterThan(60_000)
  })

  test("names both calls with the same method index the plugin registered", async () => {
    const { call, seen } = stubSidecar({ "/provider/jolli/oauth/authorize": { url: "https://auth.jolli.ai/cli" } })

    await signIn(call)

    expect(seen.at(0)?.body).toEqual({ method: 0 })
    expect(seen.at(1)?.body).toEqual({ method: 0 })
  })

  test("raises the window once the browser hands control back", async () => {
    const before = raised.focused
    const { call } = stubSidecar({ "/provider/jolli/oauth/authorize": { url: "https://auth.jolli.ai/cli" } })

    await signIn(call)

    expect(raised.focused).toBe(before + 1)
  })

  test("fails with something readable when the server will not start a flow", async () => {
    const { call } = stubSidecar({ "/provider/jolli/oauth/authorize": null })
    // A rejection mid-flow surfaces as a crash rather than "try again", so the message matters.
    expect(signIn(call)).rejects.toThrow(/could not be started/)
  })
})

describe("isSignedIn", () => {
  test("reads the same signal the TUI reads", async () => {
    const { call, seen } = stubSidecar({ "/provider": { connected: [JOLLI_PROVIDER_IDS[0]] } })
    expect(await isSignedIn(call)).toBe(true)
    expect(seen.at(0)?.path).toBe("/provider")
  })

  /**
   * ⚠ THE SPELLING IS THE WHOLE TEST. `/provider` reports one id per wire protocol and never the
   * bare auth slug — `httpapi-provider.test.ts` asserts `not.toContain(Brand.short)` — so a check
   * written against the slug answers "signed out" to everybody, and the sign-in gate comes up on
   * every launch for a student who is already signed in.
   */
  test("is false when the answer carries only the bare auth slug", async () => {
    const { call } = stubSidecar({ "/provider": { connected: [Brand.short] } })
    expect(await isSignedIn(call)).toBe(false)
  })

  /**
   * ⚠ THE TEN-SECOND DEFAULT IS NOT ENOUGH FOR THIS ONE ROUTE, AND THE CONSEQUENCE IS NOT "SLOW".
   * `/provider` assembles the instance config, which resolves the Jolli floor — a token renewal
   * when the stored one is near expiry, then the tenant's catalogue, bounded together by
   * `STARTUP_DEADLINE`. `onboarding.tsx` calls this before the course gate, so nothing has warmed
   * either; quitting first makes the main process answer false, which puts the sign-in gate in
   * front of a student who is already signed in.
   */
  test("waits longer than the default, because this call pays for a cold config", async () => {
    const { call, seen } = stubSidecar({ "/provider": { connected: [JOLLI_PROVIDER_IDS[0]] } })
    await isSignedIn(call)
    expect(seen.at(0)?.timeoutMs).toBeGreaterThan(20_000)
  })

  test("is false when the server lists no Jolli credential", async () => {
    const { call } = stubSidecar({ "/provider": { connected: ["anthropic"] } })
    expect(await isSignedIn(call)).toBe(false)
  })

  test("is false rather than a crash when the answer has no shape at all", async () => {
    const { call } = stubSidecar({ "/provider": undefined })
    expect(await isSignedIn(call)).toBe(false)
  })
})

describe("signOut and refreshInstance", () => {
  test("removes the credential through the server that owns it", async () => {
    const { call, seen } = stubSidecar()
    await signOut(call)
    expect(seen.at(0)).toMatchObject({ method: "DELETE", path: "/auth/jolli" })
  })

  test("disposes every instance rather than restarting the process", async () => {
    /**
     * The credential no longer travels in the sidecar's environment, so what goes stale after a
     * sign-in is the instance config. It has to be every instance, not the default one: this app
     * can already have a project open when the student signs in, and the restart it replaced
     * refreshed all of them by construction.
     */
    const { call, seen } = stubSidecar()
    await refreshInstance(call)
    expect(seen.at(0)).toMatchObject({ method: "POST", path: "/global/dispose" })
  })
})
