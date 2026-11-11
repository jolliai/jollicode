import { describe, expect, test } from "bun:test"
import { Jolli } from "@opencode-ai/schema/jolli"
import { ServerConnection } from "@/context/server"
import {
  groupChatHref,
  groupChatRouteId,
  legacySessionHref,
  legacySessionServer,
  requireServerKey,
  rootSession,
  sessionHref,
} from "./session-route"

describe("session routes", () => {
  test("uses the unique persisted server for a legacy session route", () => {
    expect(
      legacySessionServer(
        [{ type: "session", server: ServerConnection.Key.make("server-b"), sessionId: "session-1" }],
        "session-1",
        ServerConnection.Key.make("server-a"),
      ),
    ).toBe(ServerConnection.Key.make("server-b"))
  })

  test("prefers the active server when a legacy session ID is ambiguous", () => {
    expect(
      legacySessionServer(
        [
          { type: "session", server: ServerConnection.Key.make("server-a"), sessionId: "session-1" },
          { type: "session", server: ServerConnection.Key.make("server-b"), sessionId: "session-1" },
        ],
        "session-1",
        ServerConnection.Key.make("server-b"),
      ),
    ).toBe(ServerConnection.Key.make("server-b"))
  })

  test("builds and decodes a server-keyed session route", () => {
    const server = ServerConnection.Key.make("https://example.com:4096")
    const href = sessionHref(server, "session-1")

    expect(href).toBe("/server/aHR0cHM6Ly9leGFtcGxlLmNvbTo0MDk2/session/session-1")
    expect(requireServerKey(href.split("/")[2])).toBe(server)
  })

  test("rejects malformed server keys", () => {
    expect(() => requireServerKey("not-base64")).toThrow("Invalid server route")
  })

  test("builds the legacy directory-keyed route", () => {
    expect(legacySessionHref("/Users/example/project", "session-1")).toBe(
      "/L1VzZXJzL2V4YW1wbGUvcHJvamVjdA/session/session-1",
    )
  })

  test("resolves the root session", async () => {
    const sessions: Record<string, { id: string; parentID?: string }> = {
      child: { id: "child", parentID: "parent" },
      parent: { id: "parent", parentID: "root" },
      root: { id: "root" },
    }

    expect(
      await rootSession(sessions.child, async (id) => {
        const session = sessions[id]
        if (!session) throw new Error(`Missing session: ${id}`)
        return session
      }),
    ).toBe(sessions.root)
  })

  test("rejects a parent cycle", async () => {
    const sessions: Record<string, { id: string; parentID?: string }> = {
      child: { id: "child", parentID: "parent" },
      parent: { id: "parent", parentID: "child" },
    }

    expect(rootSession(sessions.child, async (id) => sessions[id]!)).rejects.toThrow("Session parent cycle: child")
  })
})

describe("group chat route ids", () => {
  const chatID = Jolli.GroupChatID.make("school:course:chat-1")

  test("an encoded org-scoped id opens; anything else is not found instead of throwing", () => {
    expect(groupChatRouteId("school%3Acourse%3Achat-1")).toBe(chatID)
    expect(groupChatRouteId("school:course:chat-1")).toBe(chatID)
    expect(groupChatRouteId("%E0%A4%A")).toBeUndefined()
    expect(groupChatRouteId("bare-id")).toBeUndefined()
    expect(groupChatRouteId("school%3Acourse%3A..%2Fescape")).toBeUndefined()
    expect(groupChatRouteId(undefined)).toBeUndefined()
  })

  test("reads back the id of the address it makes", () => {
    const href = groupChatHref(ServerConnection.Key.make("http://localhost:4096"), chatID)
    expect(groupChatRouteId(href.split("/").at(-1))).toBe(chatID)
  })
})
