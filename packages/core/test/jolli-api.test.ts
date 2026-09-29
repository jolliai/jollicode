import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import {
  fetchConversationShares,
  fetchConversationVisibility,
  fetchCourses,
  fetchModelIndex,
  gatewayRequest,
  JolliApiError,
  shareConversation,
  unshareConversation,
} from "../src/jolli/api"

/** Something to send, and something to file the snapshot under. See `GatewayRequest.identity`. */
const CREDENTIAL = { token: "jwt", identity: "student-a" }

/**
 * ⚠ THE CLIENT IS A LAYER, NOT A PATCHED `fetch`. `api.ts` asks the context for an `HttpClient`, so
 * a stub goes in the same way the real one does — which is also what lets these assert the exact
 * request that went out, headers and URL included.
 */
function stub(handler: (request: HttpClientRequest.HttpClientRequest) => Response) {
  const seen: HttpClientRequest.HttpClientRequest[] = []
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      seen.push(request)
      return Effect.succeed(HttpClientResponse.fromWeb(request, handler(request)))
    }),
  )
  return { seen, layer }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const course = {
  id: 7,
  name: "Systems Programming",
  description: null,
  code: "CS 310",
  status: "published",
  requiresCoding: true,
  endsOn: null,
  viewerRole: "course-student",
  isStaff: false,
}

describe("gatewayRequest", () => {
  test("keeps a subdomain tenant in the origin and names no slug", () => {
    expect(gatewayRequest("https://acme.jolli.ai", CREDENTIAL)).toEqual({
      origin: "https://acme.jolli.ai",
      token: "jwt",
      identity: "student-a",
    })
  })

  /**
   * ⚠ THE API IS MOUNTED ON THE ORIGIN EVEN WHEN THE TENANT IS ADDRESSED PATH-WISE. Concatenating
   * `/api/courses` onto `https://host/acme` reaches the app router, not the API, so the slug has to
   * leave the URL here and travel as a header instead.
   */
  test("splits a path-addressed tenant into an origin and a slug", () => {
    expect(gatewayRequest("https://jolli-local.me/dev", CREDENTIAL)).toEqual({
      origin: "https://jolli-local.me",
      tenantSlug: "dev",
      token: "jwt",
      identity: "student-a",
    })
  })

  // It re-checks rather than trusting whoever stored the URL: this request carries a credential.
  test("refuses a host outside the allowlist and anything that is not a URL", () => {
    expect(gatewayRequest("https://evil.example", CREDENTIAL)).toBeUndefined()
    expect(gatewayRequest("https://jolli.ai.evil.example", CREDENTIAL)).toBeUndefined()
    expect(gatewayRequest("http://acme.jolli.ai", CREDENTIAL)).toBeUndefined()
    expect(gatewayRequest("not a url", CREDENTIAL)).toBeUndefined()
  })
})

describe("fetchCourses", () => {
  test("authenticates as the student and asks the origin, not the tenant path", async () => {
    const http = stub(() => json([course]))
    const courses = await Effect.runPromise(
      fetchCourses({ origin: "https://jolli-local.me", tenantSlug: "dev", token: "jwt", identity: "student-a" }).pipe(
        Effect.provide(http.layer),
      ),
    )
    expect(courses.map((c) => c.code)).toEqual(["CS 310"])
    expect(http.seen[0]?.url).toBe("https://jolli-local.me/api/courses")
    expect(http.seen[0]?.headers["authorization"]).toBe("Bearer jwt")
    expect(http.seen[0]?.headers["x-tenant-slug"]).toBe("dev")
  })

  test("a subdomain tenant sends no slug header, because the host already says who it is", async () => {
    const http = stub(() => json([]))
    await Effect.runPromise(
      fetchCourses({ origin: "https://acme.jolli.ai", token: "jwt", identity: "student-a" }).pipe(
        Effect.provide(http.layer),
      ),
    )
    expect(http.seen[0]?.headers["x-tenant-slug"]).toBeUndefined()
  })

  /**
   * ⚠ 404 IS AN ORDINARY ANSWER ON THESE ROUTES — `assistant-choices` answers it for a course the
   * viewer cannot read — so the status has to survive onto the error for a caller to tell it from a
   * gateway that fell over.
   */
  test("carries the status onto the error rather than losing it", async () => {
    const http = stub(() => json({ message: "nope" }, 404))
    const error = await Effect.runPromise(
      fetchCourses({ origin: "https://acme.jolli.ai", token: "jwt", identity: "student-a" }).pipe(
        Effect.provide(http.layer),
        Effect.flip,
      ),
    )
    expect(error).toBeInstanceOf(JolliApiError)
    expect(error.status).toBe(404)
    expect(error.path).toBe("/api/courses")
    // 404 is an answer, not a wobble: retrying it would delay a verdict the gateway already gave.
    expect(http.seen.length).toBe(1)
  })

  // A body the schema does not recognise is a failure, not a half-decoded course list.
  test("refuses a response it cannot decode", async () => {
    const http = stub(() => json([{ id: "seven" }]))
    const error = await Effect.runPromise(
      fetchCourses({ origin: "https://acme.jolli.ai", token: "jwt", identity: "student-a" }).pipe(
        Effect.provide(http.layer),
        Effect.flip,
      ),
    )
    expect(error).toBeInstanceOf(JolliApiError)
  })

  // A gateway restarting under a student is the ordinary case these routes are retried for.
  test("retries a transient failure rather than reporting the catalogue gone", async () => {
    let attempt = 0
    const http = stub(() => (++attempt < 3 ? json({ message: "restarting" }, 503) : json([course])))
    const courses = await Effect.runPromise(
      fetchCourses({ origin: "https://acme.jolli.ai", token: "jwt", identity: "student-a" }).pipe(
        Effect.provide(http.layer),
      ),
    )
    expect(courses.length).toBe(1)
    expect(http.seen.length).toBe(3)
  })
})

describe("fetchModelIndex", () => {
  const model = (id: string, name: string, isActive = true) => ({
    id,
    name,
    category: "Premium" as const,
    description: null,
    isActive,
  })

  /**
   * ⚠ THE VENDOR GROUPING IS FLATTENED HERE, BUT ITS PROTOCOL AND NAME STAY ON EACH MODEL. The
   * provider config needs the protocol to select the correct upstream SDK, and the name to label
   * the picker group. A disabled provider takes its whole group with it.
   */
  test("flattens the providers by UUID and drops what is switched off", async () => {
    const http = stub(() =>
      json([
        {
          id: "p1",
          name: "anthropic",
          protocol: "anthropic",
          isActive: true,
          models: [model("uuid-opus", "claude-opus-4-8")],
        },
        {
          id: "p2",
          name: "openai",
          protocol: "openai",
          isActive: true,
          models: [model("uuid-retired", "gpt-4", false), model("uuid-gpt", "gpt-5.5")],
        },
        {
          id: "p3",
          name: "google",
          protocol: "google",
          isActive: false,
          models: [model("uuid-gemini", "gemini-3")],
        },
      ]),
    )
    const index = await Effect.runPromise(
      fetchModelIndex({ origin: "https://acme.jolli.ai", token: "jwt", identity: "student-a" }).pipe(
        Effect.provide(http.layer),
      ),
    )
    expect([...index.keys()].sort()).toEqual(["uuid-gpt", "uuid-opus"])
    expect(index.get("uuid-opus")?.name).toBe("claude-opus-4-8")
    expect(index.get("uuid-opus")?.protocol).toBe("anthropic")
    expect(index.get("uuid-gpt")?.protocol).toBe("openai")
    expect(index.get("uuid-opus")?.vendor).toBe("anthropic")
    expect(index.get("uuid-gpt")?.vendor).toBe("openai")
    expect(http.seen[0]?.url).toBe("https://acme.jolli.ai/api/agent/models")
  })

  /**
   * ⚠ AN OFFLINE REQUEST MUST FAIL, NOT DIE. A transport error carries a `response` field that is
   * undefined, and reading through it threw inside the error constructor — which turned every
   * offline catalogue load into a defect and took the stale-cache fallback with it.
   */
  test("a request that never reached a server fails with no status rather than defecting", async () => {
    const layer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, description: "getaddrinfo ENOTFOUND" }),
          }),
        ),
      ),
    )
    const error = await Effect.runPromise(
      fetchModelIndex({ origin: "https://acme.jolli.ai", token: "jwt", identity: "student-a" }).pipe(
        Effect.provide(layer),
        Effect.flip,
      ),
    )
    expect(error).toBeInstanceOf(JolliApiError)
    expect(error.status).toBeUndefined()
  })
})

describe("the session-share calls", () => {
  const request = { origin: "https://acme.jolli.ai", tenantSlug: "acme", token: "jwt", identity: "student-a" }
  const visibility = { courseCode: "CS 310", courseId: 7, mayControl: true, shares: [] }

  test("reads only the visibility off the conversation detail", async () => {
    const http = stub(() => json({ publicSessionId: "ses_1", timeline: [{ huge: true }], visibility }))
    const result = await Effect.runPromise(
      fetchConversationVisibility(request, "ses_1").pipe(Effect.provide(http.layer)),
    )
    expect(result).toEqual(visibility)
    expect(http.seen[0]?.url).toBe("https://acme.jolli.ai/api/agent/convos/ses_1")
    expect(http.seen[0]?.headers["x-tenant-slug"]).toBe("acme")
  })

  test("reads the visibility from the owner's shares read, without the conversation", async () => {
    const http = stub(() => json(visibility))
    const result = await Effect.runPromise(fetchConversationShares(request, "ses_1").pipe(Effect.provide(http.layer)))
    expect(result).toEqual(visibility)
    expect(http.seen.map((sent) => sent.url)).toEqual(["https://acme.jolli.ai/api/agent/convos/ses_1/shares"])
  })

  /** ⚠ A 404 FAILS AS IT IS — ONE REQUEST, AND NEVER THE DETAIL WITH ITS TIMELINE BEHIND IT. */
  test("fails 404 for a conversation the gateway does not have, without asking the detail", async () => {
    const http = stub(() => json({ error: "Conversation not found" }, 404))
    const error = await Effect.runPromise(
      fetchConversationShares(request, "ses_new").pipe(Effect.provide(http.layer), Effect.flip),
    )
    expect(error).toBeInstanceOf(JolliApiError)
    expect(error.status).toBe(404)
    expect(http.seen.map((sent) => sent.url)).toEqual(["https://acme.jolli.ai/api/agent/convos/ses_new/shares"])
  })

  /**
   * ⚠ THE CLASS GOES OUT UNDER `subjectUserId`, THE FIELD'S DEPLOYED NAME. jolliedu kept it rather
   * than break every client already sending it.
   */
  test("posts the subject and level to the conversation's shares", async () => {
    const http = stub(() => json(visibility))
    await Effect.runPromise(shareConversation(request, "ses_1", "everyone", "view").pipe(Effect.provide(http.layer)))
    const sent = http.seen[0]
    expect(sent?.method).toBe("POST")
    expect(sent?.url).toBe("https://acme.jolli.ai/api/agent/convos/ses_1/shares")
    expect(sent?.headers["authorization"]).toBe("Bearer jwt")
    const body = sent?.body
    expect(body?._tag).toBe("Uint8Array")
    expect(JSON.parse(new TextDecoder().decode(body?._tag === "Uint8Array" ? body.body : undefined))).toEqual({
      subjectUserId: "everyone",
      access: "view",
    })
  })

  test("carries a refusal's code through, not just its status", async () => {
    const http = stub(() => json({ error: "Only people in this course", code: "subject_not_in_course" }, 400))
    const error = await Effect.runPromise(
      shareConversation(request, "ses_1", 9, "view").pipe(Effect.provide(http.layer), Effect.flip),
    )
    expect(error).toBeInstanceOf(JolliApiError)
    expect(error.status).toBe(400)
    expect(error.code).toBe("subject_not_in_course")
  })

  test("names the subject in the path to take a grant back", async () => {
    const http = stub(() => json(visibility))
    await Effect.runPromise(unshareConversation(request, "ses_1", 9).pipe(Effect.provide(http.layer)))
    expect(http.seen[0]?.method).toBe("DELETE")
    expect(http.seen[0]?.url).toBe("https://acme.jolli.ai/api/agent/convos/ses_1/shares/9")
  })
})
