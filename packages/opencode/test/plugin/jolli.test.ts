import { afterAll, afterEach, describe, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { Brand } from "@opencode-ai/core/brand"
import { JolliSession } from "@opencode-ai/core/jolli/session"
import type { JolliStore } from "@opencode-ai/core/jolli/store"
import { Effect, Layer } from "effect"
import { JolliAuthPlugin } from "@/plugin/jolli"

const signedInRow: JolliStore.Row = {
  id: "usr_1",
  subject: "usr_1",
  email: null,
  base_url: "https://acme.jolli.ai",
  access_token: "access-1",
  refresh_token: "refresh-1",
  token_expiry: null,
  cache_key: "cache-key",
  time_created: 0,
  time_updated: 0,
}

/**
 * The plugin API is Promise-shaped and the credential lives behind an Effect service, so the real
 * plugin is handed a bridge. This is the smallest thing that is still that bridge.
 */
function harness(session: Partial<JolliSession.Interface> = {}) {
  const unused = () => {
    throw new Error("the Jolli plugin should not need this")
  }
  return {
    promise: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.runPromise(
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
        effect.pipe(Effect.provide(Layer.mock(JolliSession.Service)(session))) as Effect.Effect<A, E>,
      ),
    fork: unused,
    run: unused,
    bind: unused,
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  } as unknown as Parameters<typeof JolliAuthPlugin>[1]["bridge"]
}

const originalFetch = globalThis.fetch

// A developer's shell may export JOLLI_URL to point every Jolli client at a dev tenant. The
// sign-in test below asserts against the default auth hub, so isolate the file from that env for
// the duration of the run and restore it once done.
const originalJolliUrl = process.env["JOLLI_URL"]
delete process.env["JOLLI_URL"]

afterEach(() => {
  globalThis.fetch = originalFetch
  delete process.env["JOLLICODE_LOCKDOWN_STRICT"]
  delete process.env["JOLLICODE_GATEWAY_URL"]
  delete process.env["JOLLI_URL"]
})

afterAll(() => {
  if (originalJolliUrl === undefined) delete process.env["JOLLI_URL"]
  else process.env["JOLLI_URL"] = originalJolliUrl
})

/**
 * The plugin is the bare CLI/TUI's only way in, and everything it returns is consumed by code that
 * cannot ask it again: the client opens `url` itself, and `callback()` is what stores the
 * credential — in the shared database, not in `auth.json`.
 */
describe("plugin.jolli", () => {
  test("offers one oauth method, for the one provider this install may reach", async () => {
    const hooks = await JolliAuthPlugin({} as PluginInput, { bridge: harness() })
    expect(hooks.auth?.provider).toBe(Brand.short)
    /**
     * ⚠ THIS FLAG AND "THE LOADER IGNORES `auth()`" ARE THE SAME FACT. `provider.ts` skips a loader
     * whose provider has no `auth.json` entry, and Jolli never has one — remove either and the
     * other stops meaning anything.
     */
    expect(hooks.auth?.loadWithoutCredential).toBe(true)
    expect(hooks.auth?.methods).toHaveLength(1)
    expect(hooks.auth?.methods[0]).toMatchObject({ type: "oauth", label: `Sign in to ${Brand.platform}` })
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

  test("stores the credential itself and reports a managed success", async () => {
    stubJolli(async () => Response.json({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 28_800 }))
    const stored: unknown[] = []
    const started = await authorize({ signIn: (credentials) => Effect.sync(() => stored.push(credentials)) as never })

    /**
     * ⚠ NOTHING FOR `ProviderAuth` TO WRITE, WHICH IS THE POINT OF THE `managed` SHAPE. The other
     * two result shapes put a credential into `auth.json`; this one says it is already somewhere
     * better — the database the desktop sidecar and the bare CLI both read.
     */
    expect(await callbackWith(started, { code: "one-time", state: stateOf(started) })).toEqual({
      type: "success",
      provider: Brand.short,
      managed: true,
    })
    expect(stored).toEqual([{ token: "access-1", refreshToken: "refresh-1", expiresIn: 28_800 }])
  })

  test("reports a failed sign-in instead of throwing out of the callback", async () => {
    stubJolli(async () => new Response("", { status: 404 }))
    const started = await authorize()

    // The client is mid-flow; a rejection here would surface as a crash rather than "try again".
    expect(await callbackWith(started, { code: "stale", state: stateOf(started) })).toEqual({ type: "failed" })
  })
})

/**
 * THE LOADER IS HOW A REFRESHED TOKEN REACHES A MODEL CALL, AND THE `fetch` IS THE WHOLE MECHANISM.
 *
 * ⚠ PROVIDER OPTIONS ARE RESOLVED ONCE AND CACHED FOR THE LIFE OF THE PROCESS. Anything written to
 * `apiKey` here is frozen at that moment, so with an eight-hour access token a desktop left open
 * overnight would 401 on every message after hour eight. `provider.ts` calls this `fetch` per
 * request instead, which is why the credential is resolved inside it.
 */
describe("plugin.jolli — the loader", () => {
  const loaderOf = async (session: Partial<JolliSession.Interface>) => {
    const hooks = await JolliAuthPlugin({} as PluginInput, { bridge: harness(session) })
    return hooks.auth!.loader!(async () => undefined as never, {} as never)
  }

  test("declares nothing at all while signed out", async () => {
    // A `fetch` with no credential behind it can only fail; declaring none is the honest answer.
    expect(await loaderOf({ current: () => Effect.succeed(undefined) })).toEqual({})
  })

  test("resolves the credential on every request rather than once", async () => {
    let issued = 0
    const options = await loaderOf({
      current: () => Effect.succeed(signedInRow),
      token: () => Effect.succeed(`access-${++issued}`),
    })

    const seen: Request[] = []
    stubJolli(async (request) => {
      seen.push(request)
      return Response.json({})
    })

    await options["fetch"]("https://acme.jolli.ai/api/v1/messages")
    await options["fetch"]("https://acme.jolli.ai/api/v1/messages")

    expect(seen.map((request) => request.headers.get("authorization"))).toEqual(["Bearer access-1", "Bearer access-2"])
    // The placeholder is never used for gateway authentication; it only lets the SDK build a request.
    expect(options["apiKey"]).toBeTruthy()
  })

  test("replaces SDK authorization while preserving vendor credential headers", async () => {
    const options = await loaderOf({
      current: () => Effect.succeed(signedInRow),
      token: () => Effect.succeed("access-1"),
    })

    const seen: Request[] = []
    stubJolli(async (request) => {
      seen.push(request)
      return Response.json({})
    })

    await options["fetch"]("https://acme.jolli.ai/api/v1/messages", {
      headers: {
        "x-api-key": "sdk-anthropic-key",
        "x-goog-api-key": "sdk-google-key",
        authorization: "Bearer sdk-openai-key",
      },
    })

    expect(seen.at(0)?.headers.get("authorization")).toBe("Bearer access-1")
    expect(seen.at(0)?.headers.get("x-api-key")).toBe("sdk-anthropic-key")
    expect(seen.at(0)?.headers.get("x-goog-api-key")).toBe("sdk-google-key")
  })

  test.each([
    ["anthropic", "/api/v1/messages", "x-api-key"],
    ["openai", "/api/v1/responses", "authorization"],
    ["google", "/api/v1beta/models/gemini-test:streamGenerateContent", "x-goog-api-key"],
  ] as const)("authenticates %s requests without dropping SDK headers", async (_protocol, path, credentialHeader) => {
    const options = await loaderOf({
      current: () => Effect.succeed(signedInRow),
      token: () => Effect.succeed("access-1"),
    })

    const seen: Request[] = []
    stubJolli(async (request) => {
      seen.push(request)
      return Response.json({})
    })

    await options["fetch"](
      new Request(`https://acme.jolli.ai${path}`, { headers: { [credentialHeader]: "sdk-credential" } }),
      { headers: { "x-trace-id": "trace-1" } },
    )

    expect(seen.at(0)?.headers.get("authorization")).toBe("Bearer access-1")
    if (credentialHeader !== "authorization") {
      expect(seen.at(0)?.headers.get(credentialHeader)).toBe("sdk-credential")
    }
    expect(seen.at(0)?.headers.get("x-trace-id")).toBe("trace-1")
  })

  test("renews and retries once when the gateway refuses the token", async () => {
    /**
     * ⚠ THE ONLY PLACE A 401 REACHES THE REFRESH PATH. A revoked token is refused long before it
     * expires, and expiry is what normally triggers a renewal — so without this retry a password
     * change leaves every message failing for the rest of the token's life while the app still
     * believes it is signed in.
     */
    const options = await loaderOf({
      current: () => Effect.succeed(signedInRow),
      token: () => Effect.succeed("access-1"),
      refused: () => Effect.succeed("access-2"),
    })

    const seen: Request[] = []
    stubJolli(async (request) => {
      seen.push(request)
      return seen.length === 1 ? new Response("", { status: 401 }) : Response.json({})
    })

    const answer = await options["fetch"]("https://acme.jolli.ai/api/v1beta/models/gemini-test:streamGenerateContent", {
      headers: { "x-goog-api-key": "sdk-google-key" },
    })

    expect(seen.map((request) => request.headers.get("authorization"))).toEqual(["Bearer access-1", "Bearer access-2"])
    expect(seen.map((request) => request.headers.get("x-goog-api-key"))).toEqual(["sdk-google-key", "sdk-google-key"])
    // The student's message goes through on the renewed token rather than surfacing the refusal.
    expect(answer.status).toBe(200)
  })

  test("does not retry when the renewal could not replace the token", async () => {
    // `refused` answers with the token it was given when Jolli could not be reached — an outage
    // must not end a session. Re-sending it would be a second identical failure.
    const options = await loaderOf({
      current: () => Effect.succeed(signedInRow),
      token: () => Effect.succeed("access-1"),
      refused: (token) => Effect.succeed(token),
    })

    const seen: Request[] = []
    stubJolli(async (request) => {
      seen.push(request)
      return new Response("", { status: 401 })
    })

    const answer = await options["fetch"]("https://acme.jolli.ai/api/v1/messages")

    expect(seen.length).toBe(1)
    expect(answer.status).toBe(401)
  })

  /**
   * ⚠ A RETRY THAT DROPS THE BODY IS WORSE THAN NO RETRY, AND NOTHING ELSE HERE WOULD CATCH IT. The
   * test above retries a request with no body, so it passes whether or not the student's message
   * survives — and a renewed token carrying an empty body reaches the gateway as a well-formed
   * request with nothing in it. Both shapes are covered because `provider.ts` hands some calls a
   * `Request` and others a URL plus `init`, and the two travel different lines of the retry.
   */
  test.each([
    ["a url and an init body", (body: string) => ["https://acme.jolli.ai/api/v1/messages", { method: "POST", body }]],
    [
      "a Request that owns its body",
      (body: string) => [new Request("https://acme.jolli.ai/api/v1/messages", { method: "POST", body })],
    ],
  ] as const)("replays the student's message on the renewed token — %s", async (_name, call) => {
    const options = await loaderOf({
      current: () => Effect.succeed(signedInRow),
      token: () => Effect.succeed("access-1"),
      refused: () => Effect.succeed("access-2"),
    })

    const body = JSON.stringify({ messages: [{ role: "user", content: "hello" }] })
    const sent: { key: string | null; body: string }[] = []
    stubJolliPreservingBody(async (request) => {
      sent.push({ key: request.headers.get("authorization"), body: await request.text() })
      return sent.length === 1 ? new Response("", { status: 401 }) : Response.json({})
    })

    // oxlint-disable-next-line typescript-eslint/no-unsafe-argument
    const answer = await options["fetch"](...(call(body) as Parameters<typeof fetch>))

    expect(answer.status).toBe(200)
    expect(sent).toEqual([
      { key: "Bearer access-1", body },
      { key: "Bearer access-2", body },
    ])
  })

  /**
   * ⚠ THE RETRY MUST NOT BE THE REQUEST THAT WAS ALREADY SENT, AND THIS RUNTIME CANNOT SHOW YOU WHY.
   * Sending a `Request` disturbs its body: node/undici marks it read, so re-sending the same object
   * throws `Body is unusable` and the student's message is lost on the one path that was supposed
   * to rescue it. That is the runtime the desktop sidecar runs on (`dist/node`, an Electron utility
   * process). Bun — which runs this suite and the bare CLI — does NOT disturb, so the assertion
   * above passes with or without the clone and proves nothing about it.
   *
   * ⚠ SO THIS ASSERTS THE INVARIANT RATHER THAN THE SYMPTOM. "The second send is a different object
   * from the first" is what the clone exists to guarantee, and it is true on every runtime.
   */
  test("retries with a copy rather than the request it already sent", async () => {
    const options = await loaderOf({
      current: () => Effect.succeed(signedInRow),
      token: () => Effect.succeed("access-1"),
      refused: () => Effect.succeed("access-2"),
    })

    const sent: unknown[] = []
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      sent.push(input)
      return sent.length === 1 ? new Response("", { status: 401 }) : Response.json({})
    }) as typeof fetch

    const request = new Request("https://acme.jolli.ai/api/v1/messages", { method: "POST", body: "{}" })
    await options["fetch"](request)

    expect(sent).toHaveLength(2)
    expect(sent[0]).toBe(request)
    expect(sent[1]).not.toBe(request)
  })

  /**
   * ⚠ THE ONE BODY THAT CANNOT BE REPLAYED, WHICH IS WHY THE RETRY IS CONDITIONAL RATHER THAN
   * UNCONDITIONAL. A stream is spent by the first send and cloning it buys nothing, so the renewal
   * still has to run — it is what ends a finished credential — but the request itself is lost.
   * Sending the stream again would either throw or send nothing at all.
   */
  test("renews but does not replay a streamed body", async () => {
    const options = await loaderOf({
      current: () => Effect.succeed(signedInRow),
      token: () => Effect.succeed("access-1"),
      refused: () => Effect.succeed("access-2"),
    })

    let renewed = false
    const sent: string[] = []
    stubJolliPreservingBody(async (request) => {
      sent.push(request.headers.get("authorization") ?? "")
      return new Response("", { status: 401 })
    })

    const answer = await options["fetch"]("https://acme.jolli.ai/api/v1/messages", {
      method: "POST",
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{}"))
          controller.close()
        },
      }),
      ...({ duplex: "half" } as RequestInit),
    })
    renewed = sent.length === 1

    expect(renewed).toBe(true)
    expect(answer.status).toBe(401)
  })

  test("surfaces the refusal rather than throwing once the credential is finished", async () => {
    // The revocation case: the renewal is refused too, so `refused` deletes the row and fails
    // signed-out. The row being gone is what turns the next screen into "sign in again"; this
    // request is already lost either way, and throwing out of `fetch` would lose it louder.
    const options = await loaderOf({
      current: () => Effect.succeed(signedInRow),
      token: () => Effect.succeed("access-1"),
      refused: () => Effect.fail(new JolliSession.JolliSignedOut({ message: "finished" })),
    })

    const seen: Request[] = []
    stubJolli(async (request) => {
      seen.push(request)
      return new Response("", { status: 401 })
    })

    const answer = await options["fetch"]("https://acme.jolli.ai/api/v1/messages")

    expect(seen.length).toBe(1)
    expect(answer.status).toBe(401)
  })

  test("never attaches the credential to an origin outside the allowlist", async () => {
    const options = await loaderOf({
      current: () => Effect.succeed(signedInRow),
      token: () => Effect.succeed("access-1"),
    })

    const seen: Request[] = []
    stubJolli(async (request) => {
      seen.push(request)
      return Response.json({})
    })

    // A config layer can set `options.baseURL`, so without this check a repository would choose
    // where the student's token gets sent. Unauthenticated is the correct failure.
    await options["fetch"]("https://evil.example/v1/messages", {
      headers: { "x-api-key": "leaked", "x-goog-api-key": "leaked", authorization: "Bearer leaked" },
    })

    expect(seen.at(0)?.headers.get("x-api-key")).toBeNull()
    expect(seen.at(0)?.headers.get("x-goog-api-key")).toBeNull()
    expect(seen.at(0)?.headers.get("authorization")).toBeNull()
  })

  /**
   * ⚠ THE ALLOWLIST IS NOT THE WHOLE ANSWER, BECAUSE A BUILD MAY PIN A GATEWAY IT CANNOT NAME. That
   * exemption is the stated point of `JOLLICODE_GATEWAY_URL` — a demo or fixture build — and it
   * held for the config's `baseURL` while this check refused the same address, so such a build put
   * every model call on the wire with no credential and 401ed on the first message. Worse, it
   * returned before the 401 handling below, so the refusal never reached `refused()` either.
   */
  test("attaches the credential to the gateway this build was pinned to", async () => {
    process.env["JOLLICODE_LOCKDOWN_STRICT"] = "1"
    process.env["JOLLICODE_GATEWAY_URL"] = "https://fixture.internal/gw"
    const options = await loaderOf({
      current: () => Effect.succeed(signedInRow),
      token: () => Effect.succeed("access-1"),
    })

    const seen: Request[] = []
    stubJolli(async (request) => {
      seen.push(request)
      return Response.json({})
    })

    await options["fetch"]("https://fixture.internal/gw/v1/messages")

    expect(seen.at(0)?.headers.get("authorization")).toBe("Bearer access-1")
  })

  /**
   * ⚠ THE PIN IS TRUSTED BECAUSE OF WHERE IT CAME FROM, NOT BECAUSE IT IS SET. `createSidecarEnv()`
   * scrubs the key and writes the build's own value, and it is the only thing that sets the strict
   * flag — so on any other surface this is just an exported variable, and honouring it would make
   * one line in `~/.zshrc` a place to send the student's credential.
   */
  test("ignores a pin on a surface the desktop did not lock", async () => {
    process.env["JOLLICODE_GATEWAY_URL"] = "https://evil.example"
    const options = await loaderOf({
      current: () => Effect.succeed(signedInRow),
      token: () => Effect.succeed("access-1"),
    })

    const seen: Request[] = []
    stubJolli(async (request) => {
      seen.push(request)
      return Response.json({})
    })

    await options["fetch"]("https://evil.example/v1/messages")

    expect(seen.at(0)?.headers.get("authorization")).toBeNull()
  })
})

async function authorize(session: Partial<JolliSession.Interface> = {}) {
  const hooks = await JolliAuthPlugin({} as PluginInput, { bridge: harness(session) })
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

/**
 * Like {@link stubJolli}, but resolves `input` and `init` the way a real `fetch` does.
 *
 * ⚠ `stubJolli` REBUILDS FROM `input.url` AND `init`, SO IT DROPS THE BODY OF A `Request` — which
 * is exactly the shape the retry has to get right. This one composes the two instead, which is the
 * whole contract the plugin leans on: the body comes from the `Request` it was handed and the
 * `authorization` from the `init` beside it, and a stub that reads only one of them is measuring
 * itself.
 *
 * ⚠ AND IT SPENDS THE CALLER'S BODY, WHICH IS THE PART THAT MAKES THE CLONE TEST MEAN ANYTHING.
 * `new Request(aRequest, init)` disturbs `aRequest` exactly as a real send does, so a retry that
 * re-sent the original instead of a clone fails here the way it would in production. A stub that
 * clones defensively passes whether the plugin clones or not, and tests nothing.
 */
function stubJolliPreservingBody(handler: (request: Request) => Promise<Response>) {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (new URL(input instanceof Request ? input.url : input.toString()).hostname === "127.0.0.1")
      return originalFetch(input, init)
    return handler(new Request(input, init))
  }) as typeof fetch
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
