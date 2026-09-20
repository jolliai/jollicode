import { afterEach, describe, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { Brand } from "@opencode-ai/core/brand"
import { JolliAuthPlugin } from "@/plugin/jolli"

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

/**
 * The plugin is the bare CLI/TUI's only way in, and everything it returns is consumed by code that
 * cannot ask it again: the client opens `url` itself, and `callback()` is what lands in `auth.json`.
 */
describe("plugin.jolli", () => {
  test("offers one oauth method, for the one provider this install may reach", async () => {
    const hooks = await JolliAuthPlugin({} as PluginInput)
    expect(hooks.auth?.provider).toBe(Brand.short)
    expect(hooks.auth?.methods).toHaveLength(1)
    expect(hooks.auth?.methods[0]).toMatchObject({ type: "oauth", label: `Sign in to ${Brand.name}` })
  })

  test("hands the sign-in URL back rather than opening a browser on the server", async () => {
    const started = await authorize()
    // `authorize` runs inside the opencode server, which is not always the user's machine — the
    // client decides how the URL gets opened.
    expect(started.method).toBe("auto")
    expect(new URL(started.url).origin).toBe("https://auth.jolli.ai")
    expect(started.instructions).toContain("browser")

    await callbackWith(started, { error: "user_denied" })
  })

  test("stores the JWT as an api credential naming the tenant it belongs to", async () => {
    stubJolli(async () => Response.json({ token: "jwt", baseUrl: "https://acme.jolli.ai" }))
    const started = await authorize()

    // `{type:"api"}` is the shape opencode fills a provider's apiKey from; the config layer reads
    // `metadata.baseUrl` back to point the provider at `<baseUrl>/api`.
    expect(await callbackWith(started, { code: "one-time", state: stateOf(started) })).toEqual({
      type: "success",
      provider: Brand.short,
      key: "jwt",
      metadata: { baseUrl: "https://acme.jolli.ai" },
    })
  })

  test("omits the metadata entirely when the backend reported no tenant", async () => {
    stubJolli(async () => Response.json({ token: "jwt" }))
    const started = await authorize()

    // Absent rather than empty: the config layer falls back to `Brand.gatewayUrl` on undefined.
    expect(await callbackWith(started, { code: "one-time", state: stateOf(started) })).toEqual({
      type: "success",
      provider: Brand.short,
      key: "jwt",
    })
  })

  test("reports a failed sign-in instead of throwing out of the callback", async () => {
    stubJolli(async () => new Response("", { status: 404 }))
    const started = await authorize()

    // The client is mid-flow; a rejection here would surface as a crash rather than "try again".
    expect(await callbackWith(started, { code: "stale", state: stateOf(started) })).toEqual({ type: "failed" })
  })
})

async function authorize() {
  const hooks = await JolliAuthPlugin({} as PluginInput)
  const method = hooks.auth?.methods[0]
  if (method?.type !== "oauth") throw new Error("expected an oauth method")
  const started = await method.authorize()
  // Narrowed here so every caller gets the "auto" flow's no-argument `callback()`.
  if (started.method !== "auto") throw new Error("expected the auto oauth flow")
  return started
}

function stateOf(started: { url: string }) {
  return new URL(started.url).searchParams.get("state") ?? ""
}

/** Drives the loopback callback the way the browser would, then resolves what the plugin reports. */
async function callbackWith(started: { url: string; callback(): Promise<unknown> }, params: Record<string, string>) {
  const target = new URL(new URL(started.url).searchParams.get("cli_callback") ?? "")
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value)
  const reported = started.callback()
  await originalFetch(target)
  return reported
}

/** Answers Jolli's exchange endpoint, leaving the loopback callback server to a real socket. */
function stubJolli(handler: (request: Request) => Promise<Response>) {
  // Asserted because `typeof fetch` carries `preconnect`, which a stub has no business having.
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    // Everything under test calls fetch with a URL, so re-parsing it is enough to inspect it.
    const request = new Request(input instanceof Request ? input.url : input.toString(), init)
    if (new URL(request.url).hostname === "127.0.0.1") return originalFetch(input, init)
    return handler(request)
  }) as typeof fetch
}
