import { afterEach, describe, expect, test } from "bun:test"
import { Brand } from "../src/brand"
import { jolliBaseConfig } from "../src/jolli/gateway-config"
import { catalogModels, MODEL_CATALOG, modelTier } from "../src/jolli/model-catalog"
import { startJolliLogin } from "../src/jolli/loopback"
import { exchangeCliCode } from "../src/jolli/exchange"
import { isJolliOriginAllowed, jolliAuthOrigin, parseJolliUrl } from "../src/jolli/origin"

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
  test("declares no provider while signed out", () => {
    const config = jolliBaseConfig({ signedIn: false, models: catalogModels() })
    // The lockdown still applies — a signed-out student must not reach another provider either.
    expect(config.enabled_providers).toEqual([Brand.short])
    // And the provider list stays genuinely empty, which is what the sign-in prompt keys off.
    expect(config).not.toHaveProperty("provider")
  })

  test("points at the signed-in tenant's gateway", () => {
    const config = jolliBaseConfig({ signedIn: true, models: catalogModels(), baseUrl: "https://acme.jolli.ai" })
    const provider = config.provider?.[Brand.short]
    expect(provider?.options.baseURL).toBe("https://acme.jolli.ai/api")
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
      models: catalogModels(),
      baseUrl: "https://jolli-local.me/t3lwf8aw",
    })
    const options = config.provider?.[Brand.short]?.options
    expect(options?.baseURL).toBe("https://jolli-local.me/api")
    expect(options?.headers).toEqual({ "x-tenant-slug": "t3lwf8aw" })
  })

  test("falls back to the brand gateway when sign-in reported no tenant", () => {
    const config = jolliBaseConfig({ signedIn: true, models: catalogModels() })
    // Used verbatim: `api.jolli.ai` is the gateway on its own host and is already the `/api` mount,
    // so appending again would point every send at `https://api.jolli.ai/api`.
    expect(config.provider?.[Brand.short]?.options.baseURL).toBe(Brand.gatewayUrl)
  })

  test("falls back to the brand gateway rather than emitting a broken baseURL", () => {
    // A stored tenant is only as good as whatever wrote it; `https://` + garbage would otherwise
    // reach the SDK as its baseURL and fail on the first send instead of here.
    const config = jolliBaseConfig({ signedIn: true, models: catalogModels(), baseUrl: "acme.jolli.ai" })
    expect(config.provider?.[Brand.short]?.options.baseURL).toBe(Brand.gatewayUrl)
  })

  test("uses a pinned gateway root verbatim and lets it outrank the tenant", () => {
    const config = jolliBaseConfig({
      signedIn: true,
      models: catalogModels(),
      gatewayUrl: "https://gw.jolli-local.me/edge",
      baseUrl: "https://acme.jolli.ai",
    })
    const options = config.provider?.[Brand.short]?.options
    // A gateway root is already the endpoint: no `/api`, and the path it carries survives.
    expect(options?.baseURL).toBe("https://gw.jolli-local.me/edge")
    // And it is not a tenant, so nothing is derived from it.
    expect(options).not.toHaveProperty("headers")
  })

  test("carries the credential only when the caller has nowhere else to keep it", () => {
    const options = jolliBaseConfig({
      signedIn: true,
      models: catalogModels(),
      baseUrl: "https://acme.jolli.ai",
      authToken: "jwt",
    }).provider?.[Brand.short]?.options
    // The desktop sidecar has no `auth.json` entry to resolve one from, so the JWT travels here —
    // as `apiKey`, which is the schema's name for the field, not a claim about what the value is.
    expect(options?.apiKey).toBe("jwt")
    expect(options?.baseURL).toBe("https://acme.jolli.ai/api")
  })

  test("sends the catalogue id upstream unless the caller routes it elsewhere", () => {
    const plain = jolliBaseConfig({ signedIn: true, models: catalogModels() })
    expect(Object.values(plain.provider?.[Brand.short]?.models ?? {})[0]).not.toHaveProperty("id")

    const routed = jolliBaseConfig({
      signedIn: true,
      models: catalogModels({ premium: "big-pickle", standard: "mid", economy: "small" }),
    })
    const models = routed.provider?.[Brand.short]?.models ?? {}
    expect(models["claude-opus-5"]).toEqual({ name: "Claude Opus 5", id: "big-pickle" })
  })

  test("declares exactly the models it was given, and nothing it knows on its own", () => {
    const config = jolliBaseConfig({
      signedIn: true,
      models: [{ id: "course-model", name: "Course Model" }],
    })
    // The grant is the server's to make; a catalogue baked in here would outlive it.
    expect(config.provider?.[Brand.short]?.models).toEqual({ "course-model": { name: "Course Model" } })
  })

  test("omits the skills key rather than declaring an empty path list", () => {
    expect(jolliBaseConfig({ signedIn: true, models: catalogModels() })).not.toHaveProperty("skills")
    expect(jolliBaseConfig({ signedIn: true, models: catalogModels(), skillsDir: "/tmp/skills" }).skills).toEqual({
      paths: ["/tmp/skills"],
    })
  })
})

describe("model catalogue", () => {
  test("reads a tier off a bare id or an opencode model key", () => {
    expect(modelTier("claude-opus-5")).toBe("premium")
    expect(modelTier(`${Brand.short}/claude-sonnet-5`)).toBe("standard")
    expect(modelTier(`${Brand.short}/claude-haiku-4-5`)).toBe("economy")
    // Unclassified rather than guessed, so the coaching nudge stays silent on an unknown model.
    expect(modelTier(`${Brand.short}/not-a-model`)).toBeUndefined()
  })

  test("carries no duplicate ids", () => {
    // `jolliBaseConfig` keys the provider's models by id, so a duplicate silently drops a row.
    expect(new Set(MODEL_CATALOG.map((model) => model.id)).size).toBe(MODEL_CATALOG.length)
  })

  test("routes every entry by its own tier and nothing by another's", () => {
    const route = { premium: "premium-upstream", standard: "standard-upstream", economy: "economy-upstream" }
    expect(catalogModels(route)).toEqual(
      MODEL_CATALOG.map((model) => ({ id: model.id, name: model.label, upstreamId: route[model.tier] })),
    )
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
