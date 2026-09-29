import { afterEach, describe, expect, test } from "bun:test"
import { Brand } from "../src/brand"
import {
  isJolliAuthOrProviderId,
  isJolliConnected,
  isJolliProviderId,
  JOLLI_PROVIDER_IDS,
  jolliBaseConfig,
  providerIdFor,
  SUPPORTED_PROTOCOLS,
} from "../src/jolli/gateway-config"
import { startJolliLogin } from "../src/jolli/loopback"
import { exchangeCliCode, JolliRefreshError, refreshCliToken } from "../src/jolli/exchange"
import { isJolliOriginAllowed, jolliAuthOrigin, parseJolliUrl } from "../src/jolli/origin"

/**
 * A tenant's models, as the gateway now supplies them: named by Registry UUID, with the wire name
 * carried separately. Grouped by wire protocol because that is how `jolliBaseConfig` consumes them
 * — one opencode provider block per protocol.
 */
const ANTHROPIC_MODELS = [
  { id: "uuid-opus", name: "claude-opus-4-8", upstreamId: "claude-opus-4-8" },
  { id: "uuid-haiku", name: "claude-haiku-4-5", upstreamId: "claude-haiku-4-5" },
]

const MODELS = { anthropic: ANTHROPIC_MODELS }

const JOLLI_ANTHROPIC = providerIdFor("anthropic")
const JOLLI_OPENAI = providerIdFor("openai")
const JOLLI_GOOGLE = providerIdFor("google")
const ALL_ENABLED = SUPPORTED_PROTOCOLS.map(providerIdFor)

const original = process.env["JOLLI_URL"]
const originalFetch = globalThis.fetch
afterEach(() => {
  if (original === undefined) delete process.env["JOLLI_URL"]
  else process.env["JOLLI_URL"] = original
  globalThis.fetch = originalFetch
})

describe("jolliAuthOrigin", () => {
  test("defaults to the auth hub and honours JOLLI_URL", () => {
    delete process.env["JOLLI_URL"]
    expect(jolliAuthOrigin()).toBe("https://auth.jolli.ai")

    process.env["JOLLI_URL"] = "https://dev.jolli-local.me/"
    expect(jolliAuthOrigin()).toBe("https://dev.jolli-local.me")
  })

  test("refuses an origin outside the allowlist", () => {
    process.env["JOLLI_URL"] = "https://evil.com"
    expect(() => jolliAuthOrigin()).toThrow(/not an allowed Jolli origin/)
  })

  test("refuses plain http and look-alike hosts", () => {
    expect(isJolliOriginAllowed("http://auth.jolli.ai")).toBe(false)
    expect(isJolliOriginAllowed("https://jolli.ai.evil.com")).toBe(false)
    expect(isJolliOriginAllowed("not a url")).toBe(false)
    expect(isJolliOriginAllowed("https://auth.jolli.ai")).toBe(true)
  })

  test("splits a path-based tenant from its origin", () => {
    expect(parseJolliUrl("https://jolli-local.me/dev")).toMatchObject({
      origin: "https://jolli-local.me",
      tenantSlug: "dev",
    })
    expect(parseJolliUrl("https://acme.jolli.ai").origin).toBe("https://acme.jolli.ai")
    expect(parseJolliUrl("https://acme.jolli.ai").tenantSlug).toBeUndefined()
  })
})

describe("jolliBaseConfig", () => {
  test("derives provider identity and connection checks from the supported protocols", () => {
    expect(JOLLI_PROVIDER_IDS).toEqual(ALL_ENABLED)
    expect(isJolliProviderId(JOLLI_OPENAI)).toBe(true)
    expect(isJolliProviderId(Brand.short)).toBe(false)
    expect(isJolliAuthOrProviderId(Brand.short)).toBe(true)
    expect(isJolliAuthOrProviderId("openai")).toBe(false)
    expect(isJolliConnected(["openai", JOLLI_GOOGLE])).toBe(true)
    expect(isJolliConnected([Brand.short, "openai"])).toBe(false)
  })

  test("declares no provider while signed out", () => {
    const config = jolliBaseConfig({ signedIn: false, models: MODELS })
    // The lockdown still applies — a signed-out student must not reach another provider either.
    // All three protocol ids stay enabled even when signed out so nothing outside them can be reached.
    expect(config.enabled_providers).toEqual(ALL_ENABLED)
    // And the provider list stays genuinely empty, which is what the sign-in prompt keys off.
    expect(config).not.toHaveProperty("provider")
  })

  test("points at the signed-in tenant's gateway", () => {
    const config = jolliBaseConfig({ signedIn: true, models: MODELS, baseUrl: "https://acme.jolli.ai" })
    const provider = config.provider?.[JOLLI_ANTHROPIC]
    expect(provider?.options.baseURL).toBe("https://acme.jolli.ai/api/v1")
    // Subdomain tenant: the host says who it is, so no header is needed.
    expect(provider?.options).not.toHaveProperty("headers")
    // Without this the provider resolves to @ai-sdk/openai-compatible and every send is refused.
    expect(provider?.npm).toBe("@ai-sdk/anthropic")
    // The credential lives in auth.json, never in the config.
    expect(provider?.options).not.toHaveProperty("apiKey")
    expect(Object.keys(provider?.models ?? {}).length).toBeGreaterThan(0)
  })

  test("declares each model's input modalities from the catalogue, so a pasted image is not refused", () => {
    const config = jolliBaseConfig({
      signedIn: true,
      models: {
        anthropic: [{ id: "uuid-vision", name: "claude-sonnet-5", inputModalities: ["text", "image", "pdf"] }],
        openai: [{ id: "uuid-text", name: "gpt-text", inputModalities: ["text"] }],
      },
    })

    expect(config.provider?.[JOLLI_ANTHROPIC]?.models?.["uuid-vision"]).toEqual({
      name: "claude-sonnet-5",
      modalities: { input: ["text", "image", "pdf"] },
      attachment: true,
    })
    // A text-only answer is declared as such, and a model that takes no files is not flagged for them.
    expect(config.provider?.[JOLLI_OPENAI]?.models?.["uuid-text"]).toEqual({
      name: "gpt-text",
      modalities: { input: ["text"] },
    })
  })

  test("drops modalities the config cannot declare, and declares nothing for a model with no answer", () => {
    const config = jolliBaseConfig({
      signedIn: true,
      models: {
        anthropic: [
          { id: "uuid-new", name: "claude-next", inputModalities: ["text", "hologram", "image"] },
          { id: "uuid-unknown", name: "claude-old" },
          { id: "uuid-empty", name: "claude-empty", inputModalities: [] },
        ],
      },
    })
    const models = config.provider?.[JOLLI_ANTHROPIC]?.models

    // One unknown literal would fail the whole config, so it is dropped rather than written.
    expect(models?.["uuid-new"]).toMatchObject({ modalities: { input: ["text", "image"] } })
    // No answer keeps the model exactly as it was declared before the catalogue knew anything.
    expect(models?.["uuid-unknown"]).toEqual({ name: "claude-old" })
    expect(models?.["uuid-empty"]).toEqual({ name: "claude-empty" })
  })

  test("keeps a path-based tenant out of the gateway URL and in a header", () => {
    // The gateway is mounted on the origin; `https://host/<slug>/api` is the app router and 404s.
    // Verified against a live path-based deployment, which is how this was found.
    const config = jolliBaseConfig({
      signedIn: true,
      models: MODELS,
      baseUrl: "https://jolli-local.me/t3lwf8aw",
    })
    const options = config.provider?.[JOLLI_ANTHROPIC]?.options
    expect(options?.baseURL).toBe("https://jolli-local.me/api/v1")
    expect(options?.headers).toEqual({ "x-tenant-slug": "t3lwf8aw" })
  })

  test("falls back to the brand gateway when sign-in reported no tenant", () => {
    const config = jolliBaseConfig({ signedIn: true, models: MODELS })
    // The brand URL is already the gateway root, so only the SDK-required version suffix is added.
    expect(config.provider?.[JOLLI_ANTHROPIC]?.options.baseURL).toBe(`${Brand.gatewayUrl}/v1`)
  })

  test("falls back to the brand gateway rather than emitting a broken baseURL", () => {
    // A stored tenant is only as good as whatever wrote it; `https://` + garbage would otherwise
    // reach the SDK as its baseURL and fail on the first send instead of here.
    const config = jolliBaseConfig({ signedIn: true, models: MODELS, baseUrl: "acme.jolli.ai" })
    expect(config.provider?.[JOLLI_ANTHROPIC]?.options.baseURL).toBe(`${Brand.gatewayUrl}/v1`)
  })

  /**
   * ⚠ THE SAME ALLOWLIST THE CATALOGUE FETCH APPLIES. `gatewayRequest` re-checks a stored tenant
   * before sending the student's token to it; this value becomes the provider's `baseURL`, and on
   * the desktop the JWT rides beside it as `options.apiKey`. Refusing an origin for the catalogue
   * while handing it the credential on every model call would be the wrong half to guard.
   */
  test("refuses a tenant outside the Jolli allowlist", () => {
    for (const baseUrl of ["https://evil.example", "http://acme.jolli.ai", "https://notjolli.ai"]) {
      const config = jolliBaseConfig({ signedIn: true, models: MODELS, baseUrl })
      expect(config.provider?.[JOLLI_ANTHROPIC]?.options.baseURL).toBe(`${Brand.gatewayUrl}/v1`)
    }
    // And the check is the shared one, so an allowlisted tenant is untouched by it.
    expect(isJolliOriginAllowed("https://acme.jolli.ai")).toBe(true)
  })

  /**
   * ⚠ A BUILD-TIME PIN IS DELIBERATELY EXEMPT. Whoever compiled the binary chose it, and aiming a
   * demo build at a local fixture is the entire purpose of the field.
   */
  test("uses a pinned gateway root and lets it outrank the tenant", () => {
    const config = jolliBaseConfig({
      signedIn: true,
      models: MODELS,
      gatewayUrl: "https://gw.jolli-local.me/edge",
      baseUrl: "https://acme.jolli.ai",
    })
    const options = config.provider?.[JOLLI_ANTHROPIC]?.options
    // A gateway root is already the endpoint: no `/api`, and the path it carries survives.
    expect(options?.baseURL).toBe("https://gw.jolli-local.me/edge/v1")
    // And it is not a tenant, so nothing is derived from it.
    expect(options).not.toHaveProperty("headers")
  })

  test("never writes a credential into the config, on either surface", () => {
    const options = jolliBaseConfig({
      signedIn: true,
      models: MODELS,
      baseUrl: "https://acme.jolli.ai",
    }).provider?.[JOLLI_ANTHROPIC]?.options
    /**
     * ⚠ THIS ASSERTION IS THE INVERSE OF THE ONE IT REPLACED, AND THE INVERSION IS THE POINT. The
     * desktop used to pass its JWT through here because its sidecar had no `auth.json` entry to
     * read. Both surfaces now resolve the credential from the shared database per request — through
     * the `fetch` `plugin/jolli.ts` installs on every Jolli provider id — so a token frozen into a
     * config object would go stale within one token lifetime, and would be a value a coursework
     * repo could overwrite, which is an identity swap rather than a nuisance.
     */
    expect(options).not.toHaveProperty("apiKey")
    expect(options?.baseURL).toBe("https://acme.jolli.ai/api/v1")
  })

  test("uses the matching SDK and versioned base URL for every protocol", () => {
    const config = jolliBaseConfig({
      signedIn: true,
      baseUrl: "https://acme.jolli.ai",
      models: {
        anthropic: [{ id: "anthropic-id", name: "Claude" }],
        openai: [{ id: "openai-id", name: "GPT" }],
        google: [{ id: "google-id", name: "Gemini" }],
      },
    })
    expect(config.provider?.[JOLLI_ANTHROPIC]).toMatchObject({
      npm: "@ai-sdk/anthropic",
      options: { baseURL: "https://acme.jolli.ai/api/v1" },
    })
    expect(config.provider?.[JOLLI_OPENAI]).toMatchObject({
      npm: "@ai-sdk/openai",
      options: { baseURL: "https://acme.jolli.ai/api/v1" },
    })
    expect(config.provider?.[JOLLI_GOOGLE]).toMatchObject({
      npm: "@ai-sdk/google",
      options: { baseURL: "https://acme.jolli.ai/api/v1beta" },
    })
  })

  test("joins a trailing-slash gateway root without a doubled separator", () => {
    const config = jolliBaseConfig({
      signedIn: true,
      gatewayUrl: "https://gw.jolli-local.me/edge/",
      models: MODELS,
    })
    expect(config.provider?.[JOLLI_ANTHROPIC]?.options.baseURL).toBe("https://gw.jolli-local.me/edge/v1")
  })

  test("labels each block with the gateway's vendor names, and none without a catalogue", () => {
    const config = jolliBaseConfig({
      signedIn: true,
      models: {
        anthropic: [{ id: "anthropic-id", name: "Claude", vendor: "Anthropic" }],
        openai: [
          { id: "openai-id", name: "GPT", vendor: "OpenAI" },
          { id: "deepseek-id", name: "DeepSeek", vendor: "DeepSeek" },
          { id: "openai-id-2", name: "GPT mini", vendor: "OpenAI" },
        ],
        google: [{ id: "google-id", name: "Gemini" }],
      },
    })
    expect(config.provider?.[JOLLI_ANTHROPIC]?.name).toBe("Anthropic")
    expect(config.provider?.[JOLLI_OPENAI]?.name).toBe("DeepSeek / OpenAI")
    // A group with no vendor at all reads as its protocol, never as the provider id.
    expect(config.provider?.[JOLLI_GOOGLE]?.name).toBe("google")
    // The desktop's ceiling is the top layer; a name here would overwrite the server's.
    expect(jolliBaseConfig({ signedIn: true }).provider?.[JOLLI_ANTHROPIC]).not.toHaveProperty("name")
  })

  test("keeps a crowded group's label short and independent of gateway order", () => {
    const openai = (...vendors: string[]) =>
      jolliBaseConfig({
        signedIn: true,
        models: { openai: vendors.map((vendor, i) => ({ id: `id-${i}`, name: `m-${i}`, vendor })) },
      }).provider?.[JOLLI_OPENAI]?.name
    expect(openai("OpenAI", "DeepSeek")).toBe(openai("DeepSeek", "OpenAI"))
    expect(openai("Qwen", "DeepSeek", "OpenAI", "Moonshot")).toBe("DeepSeek +3")
  })

  test("does not emit provider blocks outside the supported protocol allowlist", () => {
    const config = jolliBaseConfig({
      signedIn: true,
      models: { "future-protocol": [{ id: "future-id", name: "Future" }] },
    })
    expect(config.provider).toEqual({})
  })

  test("omits the models key entirely when the server is the one who knows them", () => {
    const config = jolliBaseConfig({ signedIn: true })
    /**
     * ⚠ EVERY PROTOCOL STILL GETS A BLOCK, WHICH IS WHAT SEPARATES "ABSENT" FROM "EMPTY". An empty
     * record means the catalogue is known and holds nothing, and emits no blocks at all; omitting
     * the key means the caller is not the one who knows — the desktop — and each block must still
     * exist to pin `npm` and `baseURL` past a coursework repository.
     */
    expect(Object.keys(config.provider ?? {})).toEqual(JOLLI_PROVIDER_IDS)
    // Absent, not empty: the desktop's copy is the TOP config layer, and a key it does not set is a
    // key the server's own floor still gets to supply.
    for (const id of JOLLI_PROVIDER_IDS) expect(config.provider?.[id]).not.toHaveProperty("models")
    // The ceiling itself is unconditional.
    expect(config.enabled_providers).toEqual(JOLLI_PROVIDER_IDS)
  })

  test("keys models by id and sends upstreamId on the wire", () => {
    /**
     * ⚠ THE KEY IS THE REGISTRY UUID AND THE WIRE NAME IS A SEPARATE FIELD, WHICH IS THE WHOLE
     * REASON THE TWO EXIST. Model names are not unique across vendors and this block is an object
     * keyed by id, so two same-named models would silently overwrite one another. The UUID is also
     * what a course's `allowedModelIds` already names, so a grant matches with no translation.
     */
    const models = jolliBaseConfig({ signedIn: true, models: MODELS }).provider?.[JOLLI_ANTHROPIC]?.models ?? {}
    expect(Object.keys(models)).toEqual(["uuid-opus", "uuid-haiku"])
    expect(models["uuid-opus"]).toEqual({ name: "claude-opus-4-8", id: "claude-opus-4-8" })
  })

  test("declares exactly the models it was given, and nothing it knows on its own", () => {
    const config = jolliBaseConfig({
      signedIn: true,
      models: { anthropic: [{ id: "course-model", name: "Course Model" }] },
    })
    // The grant is the server's to make; a catalogue baked in here would outlive it.
    expect(config.provider?.[JOLLI_ANTHROPIC]?.models).toEqual({ "course-model": { name: "Course Model" } })
  })

  test("turns upstream's cloud share off whether or not the student is signed in", () => {
    expect(jolliBaseConfig({ signedIn: false }).share).toBe("disabled")
    expect(jolliBaseConfig({ signedIn: true, models: MODELS }).share).toBe("disabled")
  })

  test("omits the skills key rather than declaring an empty path list", () => {
    expect(jolliBaseConfig({ signedIn: true, models: MODELS })).not.toHaveProperty("skills")
    expect(jolliBaseConfig({ signedIn: true, models: MODELS, skillsDir: "/tmp/skills" }).skills).toEqual({
      paths: ["/tmp/skills"],
    })
  })
})

/**
 * The exchange is the one call that carries a credential, so its wire shape is pinned here.
 * `globalThis.fetch` is stubbed rather than a server stood up because the allowlist admits only
 * https Jolli hosts — a loopback test server can never be a legitimate exchange target.
 */
describe("exchangeCliCode", () => {
  test("refuses to send a code to an origin outside the allowlist", async () => {
    expect(exchangeCliCode("https://evil.com", "abc")).rejects.toThrow(/Refusing to exchange/)
  })

  test("posts the code server-to-server and returns the credentials", async () => {
    const seen = stubJolli(async () => Response.json({ token: "jwt", baseUrl: "https://acme.jolli.ai/" }))

    // Trailing slash stripped: the tenant is concatenated with `/api` downstream.
    expect(await exchangeCliCode("https://acme.jolli.ai", "one-time")).toEqual({
      token: "jwt",
      baseUrl: "https://acme.jolli.ai",
    })

    const request = seen.at(0)
    expect(request?.method).toBe("POST")
    expect(request?.url).toBe("https://acme.jolli.ai/api/auth/cli-exchange")
    expect(await request?.json()).toEqual({ code: "one-time" })
    // Subdomain tenant: the host names it, so the header would be redundant.
    expect(request?.headers.get("x-tenant-slug")).toBeNull()
  })

  test("names a path-based tenant in a header, not in the path", () => {
    const seen = stubJolli(async () => Response.json({ token: "jwt" }))

    return exchangeCliCode("https://jolli-local.me/dev", "one-time").then((credentials) => {
      // The route is mounted on the origin; `/dev/api/...` reaches the app router instead.
      expect(seen.at(0)?.url).toBe("https://jolli-local.me/api/auth/cli-exchange")
      expect(seen.at(0)?.headers.get("x-tenant-slug")).toBe("dev")
      // A backend that does not report a tenant leaves the caller on `Brand.gatewayUrl`.
      expect(credentials).toEqual({ token: "jwt" })
    })
  })

  test("tells the user to sign in again when the one-time code is gone", async () => {
    // Single-use and TTL-bound, so a 404 is "you took too long" or "this URL was replayed".
    stubJolli(async () => new Response("", { status: 404 }))
    expect(exchangeCliCode("https://auth.jolli.ai", "stale")).rejects.toThrow(
      "Sign-in code expired or already used. Please sign in again.",
    )
  })

  test("reports any other HTTP failure with its status", async () => {
    stubJolli(async () => new Response("", { status: 503 }))
    expect(exchangeCliCode("https://auth.jolli.ai", "code")).rejects.toThrow("Sign-in failed (HTTP 503)")
  })

  test("reports an unreachable Jolli rather than a bare network error", async () => {
    stubJolli(async () => {
      throw new TypeError("connect ECONNREFUSED")
    })
    expect(exchangeCliCode("https://auth.jolli.ai", "code")).rejects.toThrow(
      "Couldn't reach Jolli to complete sign-in: connect ECONNREFUSED",
    )
  })

  test("names the timeout as a timeout", async () => {
    // A half-open socket is the case the bound exists for, so the message has to say so.
    stubJolli(async () => {
      throw new DOMException("The operation timed out.", "TimeoutError")
    })
    expect(exchangeCliCode("https://auth.jolli.ai", "code")).rejects.toThrow("timed out after 20s")
  })

  test("rejects a response that is not the JSON it claims to be", async () => {
    stubJolli(async () => new Response("<html>gateway</html>", { headers: { "content-type": "application/json" } }))
    expect(exchangeCliCode("https://auth.jolli.ai", "code")).rejects.toThrow(/malformed response/)
  })

  test("rejects a 200 that carries no usable token", async () => {
    stubJolli(async () => Response.json({ baseUrl: "https://acme.jolli.ai" }))
    expect(exchangeCliCode("https://auth.jolli.ai", "code")).rejects.toThrow(/did not include a token/)

    stubJolli(async () => Response.json({ token: "" }))
    expect(exchangeCliCode("https://auth.jolli.ai", "code")).rejects.toThrow(/did not include a token/)

    // A token that is not a string is the same failure, not a credential to pass on.
    stubJolli(async () => Response.json({ token: 42 }))
    expect(exchangeCliCode("https://auth.jolli.ai", "code")).rejects.toThrow(/did not include a token/)

    // A literal `null` parses as JSON, so it reaches the property reads rather than the malformed
    // branch. Without a guard that is a raw TypeError instead of anything a student could act on.
    stubJolli(async () => new Response("null", { headers: { "content-type": "application/json" } }))
    expect(exchangeCliCode("https://auth.jolli.ai", "code")).rejects.toThrow(/did not include a token/)
  })

  test("ignores a baseUrl that is not a usable string", async () => {
    stubJolli(async () => Response.json({ token: "jwt", baseUrl: 42 }))
    // Absent rather than carried through: callers fall back to `Brand.gatewayUrl` on `undefined`.
    expect(await exchangeCliCode("https://auth.jolli.ai", "code")).toEqual({ token: "jwt" })
  })
})

describe("startJolliLogin", () => {
  test("builds a loopback sign-in URL and asks for no API key", async () => {
    process.env["JOLLI_URL"] = "https://auth.jolli.ai"
    const attempt = await startJolliLogin({ clientVersion: "1.2.3" })
    const url = new URL(attempt.url)

    expect(url.origin).toBe("https://auth.jolli.ai")
    expect(url.pathname).toBe("/login")
    expect(url.searchParams.get("client")).toBe(Brand.bin)
    expect(url.searchParams.get("client_version")).toBe("1.2.3")
    // Minting a key would delete Jolli Memory's key of the same name on this machine.
    expect(url.searchParams.get("generate_api_key")).toBeNull()
    expect(url.searchParams.get("device_name")).toBeNull()

    const callback = new URL(url.searchParams.get("cli_callback") ?? "")
    expect(callback.protocol).toBe("http:")
    expect(callback.hostname).toBe("127.0.0.1")
    expect(callback.pathname).toBe("/callback")
    expect(Number(callback.port)).toBeGreaterThan(0)

    // 256-bit nonce, hex.
    expect(url.searchParams.get("state")).toMatch(/^[0-9a-f]{64}$/)

    await finish(attempt, { error: "user_denied" })
  })

  test("redeems the code and shows the branded success page", async () => {
    process.env["JOLLI_URL"] = "https://auth.jolli.ai"
    stubJolli(async () => Response.json({ token: "jwt", baseUrl: "https://acme.jolli.ai" }))
    const attempt = await startJolliLogin({ clientVersion: "test" })

    const response = await hit(attempt, { code: "one-time", state: stateOf(attempt) })
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(body).toContain(Brand.name)
    expect(body).not.toContain("OpenCode")
    expect(await attempt.wait()).toEqual({ token: "jwt", baseUrl: "https://acme.jolli.ai" })
  })

  test("shows a failed exchange on the callback page instead of a blank success", async () => {
    process.env["JOLLI_URL"] = "https://auth.jolli.ai"
    stubJolli(async () => new Response("", { status: 404 }))
    const attempt = await startJolliLogin({ clientVersion: "test" })
    const failure = attempt.wait().catch((error: Error) => error)

    const response = await hit(attempt, { code: "stale", state: stateOf(attempt) })
    expect(response.status).toBe(400)
    expect(await response.text()).toContain("expired or already used")
    expect(await failure).toMatchObject({ message: expect.stringContaining("expired or already used") })
  })

  test("rejects a callback whose state does not match", async () => {
    process.env["JOLLI_URL"] = "https://auth.jolli.ai"
    const attempt = await startJolliLogin({ clientVersion: "test" })
    const failure = attempt.wait().catch((error: Error) => error)

    const response = await hit(attempt, { code: "a".repeat(64), state: "b".repeat(64) })
    expect(response.status).toBe(400)
    expect(await failure).toMatchObject({ message: expect.stringContaining("state mismatch") })
  })

  test("rejects a non-ASCII state of matching length without crashing", async () => {
    process.env["JOLLI_URL"] = "https://auth.jolli.ai"
    const attempt = await startJolliLogin({ clientVersion: "test" })
    const failure = attempt.wait().catch((error: Error) => error)

    // 64 characters like the real nonce, but 128 UTF-8 bytes: comparing on `String.length` would
    // hand `timingSafeEqual` two different-sized buffers and crash the callback with a RangeError.
    await hit(attempt, { code: "a".repeat(64), state: "é".repeat(64) })
    expect(await failure).toMatchObject({ message: expect.stringContaining("state mismatch") })
  })

  test("reports a declined sign-in in the user's words", async () => {
    process.env["JOLLI_URL"] = "https://auth.jolli.ai"
    const attempt = await startJolliLogin({ clientVersion: "test" })
    const failure = attempt.wait().catch((error: Error) => error)

    const response = await hit(attempt, { error: "user_denied" })
    const body = await response.text()
    expect(response.status).toBe(400)
    expect(body).toContain("Authorization failed")
    // The branded page, not a raw error code.
    expect(body).not.toContain("OpenCode")
    expect(await failure).toMatchObject({ message: "Sign-in was cancelled." })
  })

  test("passes through a callback error code nobody has a message for", async () => {
    process.env["JOLLI_URL"] = "https://auth.jolli.ai"
    const attempt = await startJolliLogin({ clientVersion: "test" })
    const failure = attempt.wait().catch((error: Error) => error)

    // A code the backend grew after this table was written still has to reach the user.
    await hit(attempt, { error: "tenant_suspended" })
    expect(await failure).toMatchObject({ message: "Sign-in failed: tenant_suspended" })
  })

  test("rejects a callback carrying neither a code nor an error", async () => {
    process.env["JOLLI_URL"] = "https://auth.jolli.ai"
    const attempt = await startJolliLogin({ clientVersion: "test" })
    const failure = attempt.wait().catch((error: Error) => error)

    await hit(attempt, {})
    expect(await failure).toMatchObject({ message: expect.stringContaining("no authorization code") })
  })

  test("ignores paths other than the callback, and keeps waiting", async () => {
    process.env["JOLLI_URL"] = "https://auth.jolli.ai"
    const attempt = await startJolliLogin({ clientVersion: "test" })

    const stray = await fetch(new URL("/not-the-callback", callbackOrigin(attempt)))
    expect(stray.status).toBe(404)

    // Still listening: the stray request must not have torn the server down.
    await finish(attempt, { error: "user_denied" })
  })
})

function callbackOrigin(attempt: { url: string }) {
  return new URL(new URL(attempt.url).searchParams.get("cli_callback") ?? "").origin
}

function stateOf(attempt: { url: string }) {
  return new URL(attempt.url).searchParams.get("state") ?? ""
}

/** Drives the loopback callback the way the browser would. */
function hit(attempt: { url: string }, params: Record<string, string>) {
  const target = new URL("/callback", callbackOrigin(attempt))
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value)
  return fetch(target)
}

/** Closes an attempt a test is done with, so its server does not outlive the test. */
async function finish(attempt: { url: string; wait(): Promise<unknown> }, params: Record<string, string>) {
  const settled = attempt.wait().catch(() => undefined)
  await hit(attempt, params)
  await settled
}

/**
 * Answers Jolli's exchange endpoint and records what was sent to it, leaving the loopback callback
 * server alone so the sign-in tests still drive a real socket. Restored in `afterEach`.
 */
describe("exchangeCliCode, on a backend that issues the triple", () => {
  test("carries the access/refresh/expiry triple and the identity through", async () => {
    stubJolli(async () =>
      Response.json({
        access_token: "access",
        refresh_token: "refresh",
        expires_in: 28_800,
        token_type: "Bearer",
        baseUrl: "https://acme.jolli.ai",
        sub: "usr_1",
        email: "student@acme.edu",
      }),
    )

    expect(await exchangeCliCode("https://auth.jolli.ai", "code")).toEqual({
      token: "access",
      refreshToken: "refresh",
      // Seconds, not an absolute time: the service layer resolves it against a controllable clock.
      expiresIn: 28_800,
      subject: "usr_1",
      email: "student@acme.edu",
      baseUrl: "https://acme.jolli.ai",
    })
  })

  test("prefers access_token when a backend sends both spellings", async () => {
    stubJolli(async () => Response.json({ token: "legacy", access_token: "current" }))
    expect(await exchangeCliCode("https://auth.jolli.ai", "code")).toEqual({ token: "current" })
  })

  test("an unusable expires_in is dropped rather than failing the sign-in", async () => {
    // Same tolerance the baseUrl case has: an auxiliary field must never cost a valid token.
    stubJolli(async () => Response.json({ access_token: "access", expires_in: "soon", refresh_token: "refresh" }))
    expect(await exchangeCliCode("https://auth.jolli.ai", "code")).toEqual({
      token: "access",
      refreshToken: "refresh",
    })
  })
})

describe("refreshCliToken", () => {
  test("posts the refresh grant to the origin and returns the new triple", async () => {
    const seen = stubJolli(async () =>
      Response.json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 28_800 }),
    )

    expect(await refreshCliToken("https://jolli-local.me/dev", "refresh-1")).toEqual({
      token: "access-2",
      refreshToken: "refresh-2",
      expiresIn: 28_800,
    })

    const request = seen.at(0)
    expect(request?.url).toBe("https://jolli-local.me/api/auth/cli-refresh")
    expect(request?.headers.get("x-tenant-slug")).toBe("dev")
    expect(await request?.json()).toEqual({ grant_type: "refresh_token", refresh_token: "refresh-1" })
  })

  test("keeps working against a backend that does not rotate", async () => {
    stubJolli(async () => Response.json({ access_token: "access-2", expires_in: 60 }))
    // No refresh_token back means the caller keeps the one it already had.
    expect(await refreshCliToken("https://auth.jolli.ai", "refresh-1")).toEqual({
      token: "access-2",
      expiresIn: 60,
    })
  })

  test("treats a rejected credential as a sign-out", async () => {
    for (const status of [400, 401, 403]) {
      stubJolli(async () => new Response("", { status }))
      const error = await refreshCliToken("https://auth.jolli.ai", "spent").catch((cause) => cause)
      expect(error).toBeInstanceOf(JolliRefreshError)
      expect((error as JolliRefreshError).kind).toBe("signed-out")
    }
  })

  test("treats rate limiting and server faults as unavailable, never a sign-out", async () => {
    // The whole point: a student mid-assignment must not be logged out by a bad minute upstream.
    for (const status of [429, 500, 503]) {
      stubJolli(async () => new Response("", { status }))
      const error = await refreshCliToken("https://auth.jolli.ai", "refresh").catch((cause) => cause)
      expect((error as JolliRefreshError).kind).toBe("unavailable")
    }
  })

  test("treats an unreachable Jolli as unavailable", async () => {
    stubJolli(async () => {
      throw new TypeError("connect ECONNREFUSED")
    })
    const error = await refreshCliToken("https://auth.jolli.ai", "refresh").catch((cause) => cause)
    expect((error as JolliRefreshError).kind).toBe("unavailable")
    expect((error as Error).message).toMatch(/Couldn't reach Jolli to refresh/)
  })

  test("names the timeout as a timeout", async () => {
    stubJolli(async () => {
      throw new DOMException("The operation timed out.", "TimeoutError")
    })
    const error = await refreshCliToken("https://auth.jolli.ai", "refresh").catch((cause) => cause)
    expect((error as JolliRefreshError).kind).toBe("unavailable")
    expect((error as Error).message).toMatch(/timed out after 20s/)
  })

  test("keeps the credential when a 200 carries no token", async () => {
    // A backend bug, not a revoked credential — deleting the sign-in over it is the worse mistake.
    stubJolli(async () => Response.json({ token_type: "Bearer" }))
    const error = await refreshCliToken("https://auth.jolli.ai", "refresh").catch((cause) => cause)
    expect((error as JolliRefreshError).kind).toBe("unavailable")
  })

  test("refuses to send a refresh token to an origin outside the allowlist", async () => {
    expect(refreshCliToken("https://evil.com", "refresh")).rejects.toThrow(/Refusing to exchange/)
  })
})

function stubJolli(handler: (request: Request) => Promise<Response>) {
  const seen: Request[] = []
  // Asserted because `typeof fetch` carries `preconnect`, which a stub has no business having.
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    // Everything under test calls fetch with a URL, so re-parsing it is enough to inspect it.
    const request = new Request(input instanceof Request ? input.url : input.toString(), init)
    if (new URL(request.url).hostname === "127.0.0.1") return originalFetch(input, init)
    seen.push(request)
    return handler(request)
  }) as typeof fetch
  return seen
}
