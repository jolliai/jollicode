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
import { exchangeCliCode } from "../src/jolli/exchange"
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

  test("carries the credential only when the caller has nowhere else to keep it", () => {
    const options = jolliBaseConfig({
      signedIn: true,
      models: MODELS,
      baseUrl: "https://acme.jolli.ai",
      authToken: "jwt",
    }).provider?.[JOLLI_ANTHROPIC]?.options
    // The desktop sidecar has no `auth.json` entry to resolve one from, so the JWT travels here —
    // as `apiKey`, which is the schema's name for the field, not a claim about what the value is.
    expect(options?.apiKey).toBe("jwt")
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

  test("does not emit provider blocks outside the supported protocol allowlist", () => {
    const config = jolliBaseConfig({
      signedIn: true,
      models: { "future-protocol": [{ id: "future-id", name: "Future" }] },
    })
    expect(config.provider).toEqual({})
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
