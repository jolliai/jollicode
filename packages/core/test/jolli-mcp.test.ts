import { describe, expect, test } from "bun:test"
import { jolliMcpFetch } from "../src/jolli/mcp"
import type { OrgScope } from "../src/jolli/org-scoped-id"

const SERVER = "https://app.jolli.ai/mcp"

/** A transport stand-in that records what each request carried and answers from a script. */
function recorder(statuses: number[]) {
  const seen: Array<{ url: string; authorization: string | null; body: unknown }> = []
  const sent: Headers[] = []
  async function send(input: string | URL, init?: RequestInit) {
    const headers = new Headers(init?.headers)
    seen.push({ url: input.toString(), authorization: headers.get("authorization"), body: init?.body })
    sent.push(headers)
    return new Response("{}", { status: statuses[seen.length - 1] ?? 200 })
  }
  return { send, seen, sent }
}

/** The scope lookup for a call made in no org, or outside any course session. */
const unscoped = () => undefined

function credential(token = "live-jwt", renewed = "renewed-jwt") {
  const refusals: string[] = []
  return {
    refusals,
    token: () => Promise.resolve(token),
    refused: (refusedToken: string) => {
      refusals.push(refusedToken)
      return Promise.resolve(renewed)
    },
  }
}

describe("jolliMcpFetch", () => {
  test("attaches the session's current token to every request, replacing a configured one", async () => {
    const transport = recorder([200])
    const fetch = jolliMcpFetch(credential(), unscoped, transport.send)

    const answer = await fetch(new URL(SERVER), {
      method: "POST",
      headers: { Authorization: "Bearer stale", "x-tenant-slug": "acme" },
      body: "{}",
    })

    expect(answer.status).toBe(200)
    expect(transport.seen).toEqual([{ url: SERVER, authorization: "Bearer live-jwt", body: "{}" }])
  })

  test("reads the token per request, so a rotated credential is used without reconnecting", async () => {
    const transport = recorder([200, 200])
    let token = "first-jwt"
    const fetch = jolliMcpFetch(
      { token: () => Promise.resolve(token), refused: () => Promise.resolve(token) },
      unscoped,
      transport.send,
    )

    await fetch(SERVER, { method: "POST", body: "{}" })
    token = "second-jwt"
    await fetch(SERVER, { method: "POST", body: "{}" })

    expect(transport.seen.map((request) => request.authorization)).toEqual(["Bearer first-jwt", "Bearer second-jwt"])
  })

  test("renews once after a refusal and retries with the replacement", async () => {
    const transport = recorder([401, 200])
    const session = credential()
    const fetch = jolliMcpFetch(session, unscoped, transport.send)

    const answer = await fetch(SERVER, { method: "POST", body: "{}" })

    expect(answer.status).toBe(200)
    expect(session.refusals).toEqual(["live-jwt"])
    expect(transport.seen.map((request) => request.authorization)).toEqual(["Bearer live-jwt", "Bearer renewed-jwt"])
  })

  test("does not resend the same token when renewal could not replace it", async () => {
    const transport = recorder([401])
    const fetch = jolliMcpFetch(credential("live-jwt", "live-jwt"), unscoped, transport.send)

    const answer = await fetch(SERVER, { method: "POST", body: "{}" })

    expect(answer.status).toBe(401)
    expect(transport.seen).toHaveLength(1)
  })

  test("answers the refusal when renewal fails outright", async () => {
    const transport = recorder([401])
    const fetch = jolliMcpFetch(
      { token: () => Promise.resolve("live-jwt"), refused: () => Promise.reject(new Error("signed out")) },
      unscoped,
      transport.send,
    )

    expect((await fetch(SERVER, { method: "POST", body: "{}" })).status).toBe(401)
    expect(transport.seen).toHaveLength(1)
  })

  test("stops waiting for a renewing token as soon as the request is cancelled", async () => {
    const transport = recorder([200])
    // A token that never arrives: renewal is stuck behind a lock or a slow backend.
    const fetch = jolliMcpFetch(
      { token: () => new Promise(() => {}), refused: () => new Promise(() => {}) },
      unscoped,
      transport.send,
    )
    const controller = new AbortController()

    const pending = fetch(SERVER, { method: "POST", body: "{}", signal: controller.signal })
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
    expect(transport.seen).toHaveLength(0)
  })

  test("rejects a request cancelled before it began, without sending anything", async () => {
    const transport = recorder([200])
    let asked = 0
    const fetch = jolliMcpFetch(
      {
        token: () => {
          asked += 1
          return Promise.resolve("live-jwt")
        },
        refused: () => Promise.resolve("live-jwt"),
      },
      unscoped,
      transport.send,
    )
    const controller = new AbortController()
    controller.abort()

    await expect(fetch(SERVER, { method: "POST", signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    })
    expect(transport.seen).toHaveLength(0)
    expect(asked).toBe(1)
  })

  test("answers a cancellation during renewal with the cancellation, not the refusal", async () => {
    const transport = recorder([401, 200])
    const controller = new AbortController()
    const fetch = jolliMcpFetch(
      {
        token: () => Promise.resolve("live-jwt"),
        refused: () => {
          controller.abort()
          return new Promise(() => {})
        },
      },
      unscoped,
      transport.send,
    )

    await expect(fetch(SERVER, { method: "POST", body: "{}", signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    })
    expect(transport.seen).toHaveLength(1)
  })

  test("never sends the credential outside a Jolli origin", async () => {
    const transport = recorder([200, 200])
    const session = credential()
    const fetch = jolliMcpFetch(session, unscoped, transport.send)

    await fetch("https://coursework.example/mcp", { method: "POST", headers: { Authorization: "Bearer theirs" } })
    await fetch("http://app.jolli.ai/mcp", { method: "POST" })

    // The repository's own header reaches its own server untouched, and nothing of the student's goes anywhere.
    expect(transport.seen.map((request) => request.authorization)).toEqual(["Bearer theirs", null])
    expect(session.refusals).toEqual([])
  })

  describe("the org a call is made in", () => {
    const ACME: OrgScope = { tenantSlug: "acme", orgSlug: "main" }

    /** The scope lookup, answering `org` and counting how often it was asked. */
    function scopes(org: OrgScope | undefined) {
      const lookup = {
        asked: 0,
        scope: () => {
          lookup.asked += 1
          return org
        },
      }
      return lookup
    }

    function scopeHeaders(headers: Headers) {
      return {
        scope: headers.get("x-jolli-org-scope"),
        tenant: headers.get("x-tenant-slug"),
        org: headers.get("x-org-slug"),
      }
    }

    test("a call made in an org names it", async () => {
      const transport = recorder([200])
      const fetch = jolliMcpFetch(credential(), scopes(ACME).scope, transport.send)

      // The entry's static header names the home tenant; the call's own org replaces it, not joins it.
      await fetch(SERVER, { method: "POST", headers: { "X-Tenant-Slug": "home" }, body: "{}" })

      expect(transport.sent.map(scopeHeaders)).toEqual([{ scope: "1", tenant: "acme", org: "main" }])
    })

    test("a call made in no org sends no scope", async () => {
      const transport = recorder([200])
      const fetch = jolliMcpFetch(credential(), scopes(undefined).scope, transport.send)

      // The handshake and the tool listing are made for no session, and so in no org.
      await fetch(SERVER, { method: "POST", headers: { "x-tenant-slug": "home" }, body: "{}" })

      expect(transport.sent.map(scopeHeaders)).toEqual([{ scope: null, tenant: "home", org: null }])
    })

    test("the renewed retry keeps the scope", async () => {
      const transport = recorder([401, 200])
      const fetch = jolliMcpFetch(credential(), scopes(ACME).scope, transport.send)

      const answer = await fetch(SERVER, { method: "POST", body: "{}" })

      expect(answer.status).toBe(200)
      expect(transport.seen.map((request) => request.authorization)).toEqual(["Bearer live-jwt", "Bearer renewed-jwt"])
      expect(transport.sent.map(scopeHeaders)).toEqual([
        { scope: "1", tenant: "acme", org: "main" },
        { scope: "1", tenant: "acme", org: "main" },
      ])
    })

    test("a destination outside the Jolli origins is not asked about", async () => {
      const transport = recorder([200])
      const lookup = scopes(ACME)
      const fetch = jolliMcpFetch(credential(), lookup.scope, transport.send)

      await fetch("https://coursework.example/mcp", { method: "POST" })

      expect(lookup.asked).toBe(0)
      expect(transport.sent.map(scopeHeaders)).toEqual([{ scope: null, tenant: null, org: null }])
    })
  })
})
