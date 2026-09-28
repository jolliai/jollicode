import { describe, expect, test } from "bun:test"
import { jolliMcpFetch } from "../src/jolli/mcp"

const SERVER = "https://app.jolli.ai/mcp"

/** A transport stand-in that records what each request carried and answers from a script. */
function recorder(statuses: number[]) {
  const seen: Array<{ url: string; authorization: string | null; body: unknown }> = []
  async function send(input: string | URL, init?: RequestInit) {
    const headers = new Headers(init?.headers)
    seen.push({ url: input.toString(), authorization: headers.get("authorization"), body: init?.body })
    return new Response("{}", { status: statuses[seen.length - 1] ?? 200 })
  }
  return { send, seen }
}

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
    const fetch = jolliMcpFetch(credential(), transport.send)

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
    const fetch = jolliMcpFetch(session, transport.send)

    const answer = await fetch(SERVER, { method: "POST", body: "{}" })

    expect(answer.status).toBe(200)
    expect(session.refusals).toEqual(["live-jwt"])
    expect(transport.seen.map((request) => request.authorization)).toEqual(["Bearer live-jwt", "Bearer renewed-jwt"])
  })

  test("does not resend the same token when renewal could not replace it", async () => {
    const transport = recorder([401])
    const fetch = jolliMcpFetch(credential("live-jwt", "live-jwt"), transport.send)

    const answer = await fetch(SERVER, { method: "POST", body: "{}" })

    expect(answer.status).toBe(401)
    expect(transport.seen).toHaveLength(1)
  })

  test("answers the refusal when renewal fails outright", async () => {
    const transport = recorder([401])
    const fetch = jolliMcpFetch(
      { token: () => Promise.resolve("live-jwt"), refused: () => Promise.reject(new Error("signed out")) },
      transport.send,
    )

    expect((await fetch(SERVER, { method: "POST", body: "{}" })).status).toBe(401)
    expect(transport.seen).toHaveLength(1)
  })

  test("never sends the credential outside a Jolli origin", async () => {
    const transport = recorder([200, 200])
    const session = credential()
    const fetch = jolliMcpFetch(session, transport.send)

    await fetch("https://coursework.example/mcp", { method: "POST", headers: { Authorization: "Bearer theirs" } })
    await fetch("http://app.jolli.ai/mcp", { method: "POST" })

    // The repository's own header reaches its own server untouched, and nothing of the student's goes anywhere.
    expect(transport.seen.map((request) => request.authorization)).toEqual(["Bearer theirs", null])
    expect(session.refusals).toEqual([])
  })
})
