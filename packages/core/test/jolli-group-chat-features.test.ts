import { afterEach, expect, test } from "bun:test"
import { Schema } from "effect"
import { Jolli } from "@opencode-ai/schema/jolli"
import { chatFeatures } from "../src/jolli/group-chat-resources"
import { groupChatID } from "../src/jolli/org-scoped-id"

let server: ReturnType<typeof Bun.serve> | undefined
afterEach(() => server?.stop(true))

test.each([false, true])(
  "loads scoped group chat model choices, and a failed model list never takes asking away: %s",
  async (failed) => {
    const org = { tenantSlug: "school", orgSlug: "class" }
    const choices = [21, 99].map((id) => ({
      id,
      name: "Tutor",
      blurb: "Course tutor",
      icon: "sparkles",
      accent: 1,
      worksThroughProblems: true,
      answersFromMaterialsOnly: false,
      showCitations: true,
      modelId: "luna",
      allowedModelIds: ["luna"],
      instructions: "Staff-only instructions",
    }))
    const seen: string[] = []
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const path = new URL(request.url).pathname
        seen.push(path)
        if (path === "/api/me/courses") return Response.json({ home: org, courses: [{ id: 7, org }] })
        if (path === "/api/profile") return Response.json({ userId: 1 })
        if (path === "/api/auth/session-config") return Response.json({ voice: { input: true, readAloud: false } })
        if (path === "/api/courses/7/assistant-choices") return Response.json(choices)
        if (path === "/api/agent/models") {
          if (failed) return Response.json({ error: "Unavailable" }, { status: 503 })
          return Response.json([
            {
              id: "active",
              name: "School",
              protocol: "openai",
              isActive: true,
              models: [
                { id: "luna", name: "GPT-6 Luna", category: null, description: null, isActive: true },
                { id: "hidden", name: "Hidden", category: null, description: null, isActive: false },
              ],
            },
            {
              id: "disabled",
              name: "Disabled",
              protocol: "openai",
              isActive: false,
              models: [{ id: "sol", name: "GPT-6 Sol", category: null, description: null, isActive: true }],
            },
          ])
        }
        if (path === "/api/agent/convos/chat-1/open")
          return Response.json({
            access: "participant",
            detail: {
              publicSessionId: "chat-1",
              kind: "group",
              spaceId: 7,
              timeline: [],
              group: {
                participants: [{ userId: 1, name: "Ana", role: "student", creator: true }],
                formerPeople: [],
                aliases: [],
                mentionable: [{ id: 21, name: "Tutor" }],
              },
            },
          })
        return Response.json({ error: "Not found" }, { status: 404 })
      },
    })
    const result = await chatFeatures(
      { origin: server.url.origin, token: "test-token", identity: crypto.randomUUID() },
      groupChatID(org, "chat-1"),
    )
    expect(Schema.decodeUnknownSync(Jolli.GroupChatFeatures)(result)).toEqual(result)
    expect(result).toMatchObject({ input: true, readAloud: false })
    expect(seen).toContain("/api/courses/7/assistant-choices")
    if (failed) {
      expect(result.composer).toEqual({
        models: [],
        assistants: [{ id: 21, modelId: "luna", allowedModelIds: ["luna"] }],
        unavailable: true,
      })
      return
    }
    expect(result.composer).toEqual({
      models: [{ id: "luna", name: "GPT-6 Luna" }],
      assistants: [{ id: 21, modelId: "luna", allowedModelIds: ["luna"] }],
    })
    expect(JSON.stringify(result)).not.toContain("Staff-only")
  },
)

test("readers get no composer, and a chat that cannot be read leaves model choices unavailable", async () => {
  const org = { tenantSlug: "school", orgSlug: "class" }
  let open = () => Response.json({ error: "Unavailable" }, { status: 503 })
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const path = new URL(request.url).pathname
      if (path === "/api/auth/session-config") return Response.json({})
      if (path === "/api/agent/convos/chat-1/open") return open()
      return Response.json({ error: "Unavailable" }, { status: 503 })
    },
  })
  const request = { origin: server.url.origin, token: "test-token", identity: crypto.randomUUID() }
  expect(await chatFeatures(request, groupChatID(org, "chat-1"))).toEqual({
    input: false,
    readAloud: false,
    composer: { models: [], assistants: [], unavailable: true },
  })
  open = () =>
    Response.json({
      access: "reader",
      transcript: {
        kind: "group",
        spaceId: 7,
        timeline: [],
        group: { participants: [], formerPeople: [], aliases: [] },
      },
    })
  expect(await chatFeatures(request, groupChatID(org, "chat-1"))).toEqual({ input: false, readAloud: false })
})
