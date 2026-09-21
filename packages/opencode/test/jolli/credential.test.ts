import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import type { Auth } from "@/auth"
import { forgetJolliCatalog, JOLLI_AUTH_KEY, JOLLI_CREDENTIAL_ENV, jolliCredential } from "@/jolli/credential"

const [TOKEN_ENV, BASE_URL_ENV] = JOLLI_CREDENTIAL_ENV
const original = { token: process.env[TOKEN_ENV], baseUrl: process.env[BASE_URL_ENV] }

const restore = (key: string, value: string | undefined) => {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

afterEach(() => {
  restore(TOKEN_ENV, original.token)
  restore(BASE_URL_ENV, original.baseUrl)
})

const stored = (over: Partial<Auth.Api> = {}) => ({
  type: "api" as const,
  key: "from-auth-json",
  metadata: { baseUrl: "https://acme.jolli.ai" },
  ...over,
})

describe("jolliCredential", () => {
  test("reads the bare CLI's sign-in out of auth.json", () => {
    expect(jolliCredential(stored())).toEqual({ token: "from-auth-json", baseUrl: "https://acme.jolli.ai" })
  })

  /**
   * ⚠ THE ENVIRONMENT WINS, AND THAT IS NOT A PREFERENCE. The desktop's sidecar has no `auth.json`
   * entry to fall back to, and an earlier CLI sign-in on the same machine would otherwise have it
   * authenticate as the wrong account.
   */
  test("the desktop's environment outranks a CLI sign-in on the same machine", () => {
    process.env[TOKEN_ENV] = "from-the-keychain"
    process.env[BASE_URL_ENV] = "https://other.jolli.ai"
    expect(jolliCredential(stored())).toEqual({ token: "from-the-keychain", baseUrl: "https://other.jolli.ai" })
  })

  // Electron hands these down as strings; an empty or blank one is "not set", not a credential.
  test("a blank environment variable is not a credential", () => {
    process.env[TOKEN_ENV] = "   "
    expect(jolliCredential(stored())?.token).toBe("from-auth-json")
    process.env[TOKEN_ENV] = ""
    expect(jolliCredential(undefined)).toBeUndefined()
  })

  test("trims what the environment carries", () => {
    process.env[TOKEN_ENV] = " jwt\n"
    process.env[BASE_URL_ENV] = " https://acme.jolli.ai "
    expect(jolliCredential(undefined)).toEqual({ token: "jwt", baseUrl: "https://acme.jolli.ai" })
  })

  /**
   * ⚠ A CREDENTIAL WITHOUT A TENANT IS STILL A CREDENTIAL. `cli-exchange` on an older backend
   * reports no `baseUrl`; the provider still resolves against the brand gateway, and the callers
   * that need a tenant check for one themselves rather than guessing an origin.
   */
  test("omits the tenant rather than inventing one", () => {
    expect(jolliCredential(stored({ metadata: undefined }))).toEqual({ token: "from-auth-json" })
    process.env[TOKEN_ENV] = "jwt"
    expect(jolliCredential(undefined)).toEqual({ token: "jwt" })
  })

  test("another kind of stored auth is not a Jolli sign-in", () => {
    expect(jolliCredential(undefined)).toBeUndefined()
    expect(jolliCredential({ type: "oauth", refresh: "r", access: "a", expires: 0 })).toBeUndefined()
    expect(jolliCredential(stored({ key: "" }))).toBeUndefined()
  })
})

/**
 * ⚠ THESE DRIVE THE REAL CACHE DIRECTORY, exactly as `packages/core/test/jolli-cache.test.ts` does
 * and for the same reason: `Global.Path.cache` is resolved at import time, so it cannot be
 * redirected from a test, and the thing under test IS the file.
 */
describe("forgetJolliCatalog", () => {
  const seed = async (name: string) => {
    await mkdir(Global.Path.cache, { recursive: true })
    const file = path.join(Global.Path.cache, name)
    await writeFile(file, "{}")
    return file
  }

  test("drops the cached catalogue when the Jolli credential goes", async () => {
    const cached = await seed("jolli-catalog-forget-test.json")

    await Effect.runPromise(forgetJolliCatalog(JOLLI_AUTH_KEY))

    expect(await Bun.file(cached).exists()).toBe(false)
  })

  /**
   * ⚠ THE GUARD IS THE WHOLE LOGIC. Logging out of anthropic or openai says nothing about which
   * courses a student is enrolled in, and wiping their catalogue would sign them out of a thing
   * they never touched.
   */
  test("leaves it alone when some other provider is removed", async () => {
    const cached = await seed("jolli-catalog-other-provider.json")

    await Effect.runPromise(forgetJolliCatalog("anthropic"))

    expect(await Bun.file(cached).exists()).toBe(true)
    await rm(cached, { force: true })
  })

  test("is quiet when there is nothing cached", async () => {
    await expect(Effect.runPromise(forgetJolliCatalog(JOLLI_AUTH_KEY))).resolves.toBeUndefined()
  })
})
