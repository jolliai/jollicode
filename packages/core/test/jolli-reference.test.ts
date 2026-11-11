import { afterEach, describe, expect, test } from "bun:test"
import { Jolli } from "@opencode-ai/schema/jolli"
import { readJolliReference } from "../src/jolli/reference"
import type { GatewayRequest } from "../src/jolli/api"

let server: ReturnType<typeof Bun.serve> | undefined
afterEach(async () => {
  await server?.stop(true)
  server = undefined
})
function gateway(handle: (request: Request) => Response | Promise<Response>): GatewayRequest {
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handle })
  return { origin: server.url.origin, token: "private-test-token", identity: crypto.randomUUID() }
}
async function refuses(read: Promise<unknown>, status: number) {
  const error = await read.then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(error).toMatchObject({ status })
}
const course = { kind: "course", courseId: "school:org:32" } as const

describe("reference readers shared by every conversation", () => {
  test("ordinary course references keep the course's tenant and organization on each viewer route", async () => {
    const seen: string[] = []
    const request = gateway((request) => {
      expect(request.headers.get("authorization")).toBe("Bearer private-test-token")
      expect(request.headers.get("x-tenant-slug")).toBe("school")
      expect(request.headers.get("x-org-slug")).toBe("org")
      seen.push(new URL(request.url).pathname)
      return Response.json({ title: "Lecture", url: "https://storage.example/signed" })
    })
    for (const operation of ["read", "content", "page", "map"] as const)
      await readJolliReference(request, { target: course, reference: { kind: "material", materialId: 7 }, operation })
    expect(seen).toEqual(
      ["view", "content", "page-url", "map"].map((suffix) => `/api/courses/32/materials/7/${suffix}`),
    )
  })
  test("assignment previews use the same staff and student routes as web chat", async () => {
    const seen: string[] = []
    const request = gateway((request) => {
      seen.push(new URL(request.url).pathname)
      return Response.json({ title: "Assignment" })
    })
    for (const staffView of [false, true])
      await readJolliReference(request, {
        target: course,
        reference: { kind: "assignment", courseId: 32, assignmentId: 8, staffView },
        operation: "read",
      })
    expect(seen).toEqual(["/api/courses/32/assignments/8/student-view", "/api/courses/32/assignments/8/preview"])
  })
  test("Studio pages request a fresh signed address and structured plans use the plan endpoint", async () => {
    const seen: { path: string; method: string; body: unknown }[] = []
    const request = gateway(async (request) => {
      seen.push({
        path: new URL(request.url).pathname + new URL(request.url).search,
        method: request.method,
        body: request.method === "POST" ? await request.json() : null,
      })
      return Response.json({ url: "https://studio.example/view" })
    })
    await readJolliReference(request, {
      target: course,
      reference: { kind: "artifact", artifactId: "artifact-1", version: 3 },
      operation: "page",
    })
    await readJolliReference(request, {
      target: course,
      reference: { kind: "artifact", artifactId: "artifact-1", version: 3 },
      operation: "plan",
    })
    expect(seen).toEqual([
      { path: "/api/studio-artifacts/artifact-1/view-url", method: "POST", body: { version: 3 } },
      { path: "/api/studio-artifacts/artifact-1/plan?version=3", method: "GET", body: null },
    ])
  })
  test("a current permission refusal is preserved rather than served from another viewer's cache", async () => {
    const request = gateway(() => Response.json({ error: "Forbidden" }, { status: 403 }))
    await refuses(
      readJolliReference(request, {
        target: course,
        reference: { kind: "material", materialId: 7 },
        operation: "read",
      }),
      403,
    )
  })
  test("assignment files and frozen documents use their authorized task routes", async () => {
    const paths: string[] = []
    const request = gateway((request) => {
      paths.push(new URL(request.url).pathname)
      return Response.json({ url: "https://storage.example/file", markdown: "Submitted document" })
    })
    await readJolliReference(request, {
      target: course,
      reference: { kind: "assignmentFile", courseId: 32, assignmentId: 8, taskId: 4, fileId: 9 },
      operation: "read",
    })
    await readJolliReference(request, {
      target: course,
      reference: { kind: "assignmentDoc", courseId: 32, assignmentId: 8, taskId: 4, docId: 0, submitted: true },
      operation: "read",
    })
    expect(paths).toEqual([
      "/api/courses/32/assignments/8/parts/4/files/9/download",
      "/api/courses/32/assignments/8/parts/4/handed-in-docs/0",
    ])
  })
  test("invalid scopes, mismatched courses and unsafe artifact IDs never reach a gateway", async () => {
    let calls = 0
    const request = gateway(() => {
      calls++
      return Response.json({})
    })
    const inputs: Jolli.ReferenceRequest[] = [
      {
        target: { kind: "course", courseId: "other/../32" },
        reference: { kind: "artifact", artifactId: "artifact-1" },
        operation: "read",
      },
      {
        target: course,
        reference: { kind: "assignment", courseId: 99, assignmentId: 1, staffView: true },
        operation: "read",
      },
      { target: course, reference: { kind: "artifact", artifactId: "../private" }, operation: "page" },
      { target: course, reference: { kind: "material", materialId: 7 }, operation: "plan" },
      { target: { kind: "account" }, reference: { kind: "attachment", attachmentId: 5 }, operation: "content" },
    ]
    for (const input of inputs) await refuses(readJolliReference(request, input), 400)
    expect(calls).toBe(0)
  })
  test("group reference reads recheck access before reading any content", async () => {
    const paths: string[] = []
    const request = gateway((request) => {
      const path = new URL(request.url).pathname
      paths.push(path)
      if (path === "/api/me/courses")
        return Response.json({ home: { tenantSlug: "school", orgSlug: "org" }, courses: [] })
      return Response.json({ error: "Forbidden" }, { status: 403 })
    })
    await refuses(
      readJolliReference(request, {
        target: { kind: "group", chatID: Jolli.GroupChatID.make("school:org:chat-1") },
        reference: { kind: "material", materialId: 7 },
        operation: "read",
      }),
      403,
    )
    expect(paths).toEqual(["/api/me/courses", "/api/agent/convos/chat-1/open"])
  })
})
