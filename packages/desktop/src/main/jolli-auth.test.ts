import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { JOLLI_AUTH_TOKEN_KEY, JOLLI_BASE_URL_KEY, SETTINGS_STORE } from "./store-keys"

/**
 * ⚠ ONLY ELECTRON'S OWN SURFACE IS FAKED, AND AS LITTLE OF IT AS POSSIBLE. Everything this module
 * is worth testing — that the token is ciphertext on disk, that an unencryptable machine keeps it
 * in memory instead, that unreadable ciphertext reads as signed out — is about what really lands in
 * the real `electron-store` file, so that store is left alone and pointed at a temp `userData`.
 * The loopback sign-in it drives is the real one too; only Jolli's exchange endpoint is stubbed.
 */
const userData = mkdtempSync(join(tmpdir(), "jolli-auth-"))
const storeFile = join(userData, SETTINGS_STORE)

/** Stands in for the OS keychain: reversible here, and unreadable by any other "install". */
const keychain = { available: true, prefix: "keychain:" }

let opened = Promise.withResolvers<string>()
const raised = { minimized: true, restored: 0, shown: 0, focused: 0 }

const app = {
  getPath: () => userData,
  getVersion: () => "9.9.9",
  setPath: () => {},
  focus: () => {},
}

mock.module("electron", () => ({
  // `store.ts` reaches for the default export, `jolli-auth.ts` for the named ones, and `logging.ts`
  // — loaded for real, and inert until `initLogging()` — names three more it never calls here.
  default: { app },
  app,
  crashReporter: {},
  netLog: {},
  shell: {},
  safeStorage: {
    isEncryptionAvailable: () => keychain.available,
    encryptString: (value: string) => Buffer.from(keychain.prefix + value),
    decryptString: (value: Buffer) => {
      const text = value.toString()
      if (!text.startsWith(keychain.prefix)) throw new Error("ciphertext from another keychain")
      return text.slice(keychain.prefix.length)
    },
  },
}))

mock.module("./windows", () => ({
  openExternalURL: (url: string) => opened.resolve(url),
  getLastFocusedWindow: () => ({
    isMinimized: () => raised.minimized,
    restore: () => raised.restored++,
    show: () => raised.shown++,
    focus: () => raised.focused++,
  }),
}))

const { currentSession, signIn, signOut } = await import("./jolli-auth")
const { getStore } = await import("./store")

const originalFetch = globalThis.fetch

beforeEach(() => {
  keychain.available = true
  raised.minimized = true
  raised.restored = 0
  raised.shown = 0
  raised.focused = 0
})

afterEach(() => {
  globalThis.fetch = originalFetch
  signOut()
})

afterAll(() => {
  rmSync(userData, { recursive: true, force: true })
})

describe("jolli-auth", () => {
  test("persists the token as ciphertext and raises the window", async () => {
    const credentials = await runSignIn({ token: "student-jwt", baseUrl: "https://acme.jolli.ai" })

    expect(credentials).toEqual({ token: "student-jwt", baseUrl: "https://acme.jolli.ai" })
    // ⚠ The store file is plaintext JSON, so the bearer token must never appear in it verbatim.
    const raw = readFileSync(storeFile, "utf8")
    expect(raw).not.toContain("student-jwt")
    expect(Buffer.from(JSON.parse(raw)[JOLLI_AUTH_TOKEN_KEY], "base64").toString()).toBe("keychain:student-jwt")
    // The tenant is not a secret and stays readable.
    expect(JSON.parse(raw)[JOLLI_BASE_URL_KEY]).toBe("https://acme.jolli.ai")

    expect(currentSession()).toEqual({ token: "student-jwt", baseUrl: "https://acme.jolli.ai" })
    expect(raised).toMatchObject({ restored: 1, shown: 1, focused: 1 })
  })

  test("reads a stored session back without a sign-in", async () => {
    await runSignIn({ token: "student-jwt", baseUrl: "https://acme.jolli.ai" })
    // Drop this run's cache the way a restart would, leaving only what is on disk.
    resetSessionCache()

    expect(currentSession()).toEqual({ token: "student-jwt", baseUrl: "https://acme.jolli.ai" })
  })

  test("keeps the session in memory rather than writing a token it cannot encrypt", async () => {
    keychain.available = false
    const credentials = await runSignIn({ token: "student-jwt" })

    // ⚠ Refusing to persist beats a world-readable bearer token: this run still works, and the
    // next launch asks them to sign in again.
    expect(JSON.parse(readFileSync(storeFile, "utf8"))[JOLLI_AUTH_TOKEN_KEY]).toBe("")
    expect(credentials).toEqual({ token: "student-jwt" })
    expect(currentSession()).toEqual({ token: "student-jwt" })

    // And nothing is left behind for the next launch to half-read.
    resetSessionCache()
    expect(currentSession()).toBeUndefined()
  })

  test("forgets the tenant when a later sign-in does not report one", async () => {
    await runSignIn({ token: "first", baseUrl: "https://acme.jolli.ai" })
    await runSignIn({ token: "second" })

    // A stale tenant would point the gateway at an account this token does not belong to.
    expect(getStore().get(JOLLI_BASE_URL_KEY)).toBeUndefined()
    expect(currentSession()).toEqual({ token: "second" })
  })

  test("treats ciphertext this install cannot open as signed out", () => {
    // A keychain the user reset, or a store copied between machines. Not a crash.
    getStore().set(JOLLI_AUTH_TOKEN_KEY, Buffer.from("someone else's ciphertext").toString("base64"))
    expect(currentSession()).toBeUndefined()

    keychain.available = false
    expect(currentSession()).toBeUndefined()
  })

  test("signs out by clearing both keys", async () => {
    await runSignIn({ token: "student-jwt", baseUrl: "https://acme.jolli.ai" })

    signOut()

    expect(currentSession()).toBeUndefined()
    expect(getStore().get(JOLLI_AUTH_TOKEN_KEY)).toBeUndefined()
    expect(getStore().get(JOLLI_BASE_URL_KEY)).toBeUndefined()
  })
})

/** Runs the real loopback sign-in, answering Jolli's exchange with `payload`. */
async function runSignIn(payload: { token: string; baseUrl?: string }) {
  // One per attempt: a test that signs in twice must wait for its own browser launch.
  opened = Promise.withResolvers<string>()
  // Asserted because `typeof fetch` carries `preconnect`, which a stub has no business having.
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input instanceof Request ? input.url : input.toString(), init)
    if (new URL(request.url).hostname === "127.0.0.1") return originalFetch(input, init)
    return Response.json(payload)
  }) as typeof fetch

  const session = signIn()
  const url = new URL(await opened.promise)
  const callback = new URL(url.searchParams.get("cli_callback") ?? "")
  callback.searchParams.set("code", "one-time")
  callback.searchParams.set("state", url.searchParams.get("state") ?? "")
  await originalFetch(callback)
  return session
}

/** What a restart does: the in-memory session goes, whatever reached the store stays. */
function resetSessionCache() {
  const token = getStore().get(JOLLI_AUTH_TOKEN_KEY)
  const baseUrl = getStore().get(JOLLI_BASE_URL_KEY)
  signOut()
  if (typeof token === "string" && token) getStore().set(JOLLI_AUTH_TOKEN_KEY, token)
  if (typeof baseUrl === "string" && baseUrl) getStore().set(JOLLI_BASE_URL_KEY, baseUrl)
}
