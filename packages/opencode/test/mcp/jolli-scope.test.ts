import { describe, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { jolliMcpFetch } from "@opencode-ai/core/jolli/mcp"
import type { OrgScope } from "@opencode-ai/core/jolli/org-scoped-id"
import { JolliMcpCall } from "@/mcp/jolli-call"
import { McpCatalog } from "@/mcp/catalog"
import { Effect } from "effect"

const SERVER = "https://app.jolli.ai/mcp"
const ACME: OrgScope = { tenantSlug: "acme", orgSlug: "main" }
const BETA: OrgScope = { tenantSlug: "beta", orgSlug: "north" }

/**
 * A real MCP server and a real client on the transport the course server connects with, joined by
 * the `send` the credentialed `fetch` is handed, so every request the SDK makes is seen as it would
 * leave: which JSON-RPC method it carried and which org it named.
 */
async function connect() {
  const seen: Array<{ method: string; tenant: string | null; org: string | null; scope: string | null }> = []
  const protocol = new Server({ name: "jolliedu", version: "1.0.0" }, { capabilities: { tools: {} } })
  protocol.setRequestHandler(ListToolsRequestSchema, () =>
    Promise.resolve({
      tools: [{ name: "get_conversation_context", inputSchema: { type: "object" as const, properties: {} } }],
    }),
  )
  protocol.setRequestHandler(CallToolRequestSchema, () =>
    Promise.resolve({ content: [{ type: "text" as const, text: "ok" }] }),
  )
  const server = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    enableJsonResponse: true,
  })
  await protocol.connect(server)

  async function send(input: string | URL, init?: RequestInit) {
    const request = new Request(input, init)
    // The stream a client may open after the handshake; declining it keeps the test free of a dangling body.
    if (request.method !== "POST") return new Response(null, { status: 405 })
    const headers = new Headers(init?.headers)
    seen.push({
      method: JSON.parse(String(init?.body)).method,
      tenant: headers.get("x-tenant-slug"),
      org: headers.get("x-org-slug"),
      scope: headers.get("x-jolli-org-scope"),
    })
    return server.handleRequest(request)
  }

  const client = new Client({ name: "jollicode", version: "1.0.0" })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(SERVER), {
      // The static tenant header a path-tenant entry carries for the home org.
      requestInit: { headers: { "x-tenant-slug": "home" } },
      fetch: jolliMcpFetch(
        { token: () => Promise.resolve("live-jwt"), refused: () => Promise.resolve("live-jwt") },
        // As the MCP layer wires it.
        () => JolliMcpCall.current()?.org,
        send,
      ),
    }),
  )
  const listed = await client.listTools()
  return {
    seen,
    client,
    tool: McpCatalog.convertTool(listed.tools[0]!, client),
    close: async () => {
      await client.close()
      await protocol.close()
    },
  }
}

const options = { toolCallId: "call_course", messages: [], abortSignal: new AbortController().signal }

describe("course calls on the shared jolliedu connection", () => {
  test("a call started in an org reaches the server naming it; the handshake names none", async () => {
    const mcp = await connect()

    // As the tool loop runs it: inside an Effect fiber, the org named around the line that starts the call.
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.yieldNow
        return yield* Effect.promise(() => JolliMcpCall.run({ org: ACME }, () => mcp.tool.execute!({}, options)))
      }),
    )
    await mcp.close()

    expect(mcp.seen).toEqual([
      { method: "initialize", tenant: "home", org: null, scope: null },
      { method: "notifications/initialized", tenant: "home", org: null, scope: null },
      { method: "tools/list", tenant: "home", org: null, scope: null },
      { method: "tools/call", tenant: "acme", org: "main", scope: "1" },
    ])
  })

  test("calls in different orgs in flight together each name their own, and ones in no org none", async () => {
    const mcp = await connect()

    await Promise.all([
      JolliMcpCall.run({ org: ACME }, () => mcp.tool.execute!({}, options)),
      JolliMcpCall.run({ org: BETA }, () => mcp.client.callTool({ name: "get_conversation_context" })),
      JolliMcpCall.run({ org: undefined }, () => mcp.tool.execute!({}, options)),
      mcp.tool.execute!({}, options),
    ])
    await mcp.close()

    const calls = mcp.seen.filter((request) => request.method === "tools/call")
    expect(calls).toHaveLength(4)
    expect(calls).toContainEqual({ method: "tools/call", tenant: "acme", org: "main", scope: "1" })
    expect(calls).toContainEqual({ method: "tools/call", tenant: "beta", org: "north", scope: "1" })
    expect(calls.filter((request) => request.scope === null)).toEqual([
      { method: "tools/call", tenant: "home", org: null, scope: null },
      { method: "tools/call", tenant: "home", org: null, scope: null },
    ])
  })
})

describe("JolliMcpCall", () => {
  test("the call's org is known only inside the call", async () => {
    expect(JolliMcpCall.current()).toBeUndefined()
    const inside = await JolliMcpCall.run({ org: ACME }, async () => {
      await Promise.resolve()
      return JolliMcpCall.current()
    })
    expect(inside).toEqual({ org: ACME })
    expect(JolliMcpCall.current()).toBeUndefined()
  })
})
