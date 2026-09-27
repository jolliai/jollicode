import { describe, expect, test } from "bun:test"
import { Brand } from "@opencode-ai/core/brand"
import { providerIdFor, SUPPORTED_PROTOCOLS } from "@opencode-ai/core/jolli/gateway-config"
import { jolliCodingAgentHeaders, jolliMcpReport, jolliToolErrors } from "@/session/llm/request"
import { MessageID, SessionID } from "@/session/schema"

describe("jolli coding-agent request headers", () => {
  test("binds every supported Jolli provider request to the Jollicode session", () => {
    const sessionID = SessionID.descending()
    const turnID = MessageID.ascending()

    for (const providerID of SUPPORTED_PROTOCOLS.map(providerIdFor)) {
      expect(
        jolliCodingAgentHeaders({
          providerID,
          sessionID,
          turnID,
          clientAttemptID: "attempt-1",
          stepIndex: 0,
          courseID: "7",
          courseAssistantID: "8",
        }),
      ).toEqual({
        "x-jolli-conversation-id": sessionID,
        "x-jolli-turn-id": turnID,
        "x-jolli-attempt-id": "attempt-1",
        "x-jolli-request-id": "attempt-1:0",
        "x-jolli-step-index": "0",
        "x-jolli-space-id": "7",
        "x-jolli-assistant-id": "8",
      })
    }
  })

  test("keeps the conversation id stable across provider steps and distinct across sessions", () => {
    const firstSessionID = SessionID.descending()
    const secondSessionID = SessionID.descending()
    const base = {
      providerID: providerIdFor("openai"),
      turnID: MessageID.ascending(),
      clientAttemptID: "attempt-1",
    }

    const firstStep = jolliCodingAgentHeaders({ ...base, sessionID: firstSessionID, stepIndex: 0 })
    const secondStep = jolliCodingAgentHeaders({ ...base, sessionID: firstSessionID, stepIndex: 1 })
    const otherSession = jolliCodingAgentHeaders({ ...base, sessionID: secondSessionID, stepIndex: 0 })

    expect(firstSessionID).not.toBe(secondSessionID)
    expect(firstStep["x-jolli-conversation-id"]).toBe(firstSessionID)
    expect(secondStep["x-jolli-conversation-id"]).toBe(firstSessionID)
    expect(otherSession["x-jolli-conversation-id"]).toBe(secondSessionID)
    expect(firstStep["x-jolli-request-id"]).toBe("attempt-1:0")
    expect(secondStep["x-jolli-request-id"]).toBe("attempt-1:1")
  })

  test("does not mark auxiliary or non-Jolli provider calls as coding-agent turns", () => {
    expect(
      jolliCodingAgentHeaders({
        providerID: providerIdFor("openai"),
        sessionID: SessionID.descending(),
      }),
    ).toEqual({})
    expect(
      jolliCodingAgentHeaders({
        providerID: "openai",
        sessionID: SessionID.descending(),
        turnID: MessageID.ascending(),
        clientAttemptID: "attempt-1",
        stepIndex: 0,
      }),
    ).toEqual({})
    expect(
      jolliCodingAgentHeaders({
        providerID: `${Brand.short}-unsupported`,
        sessionID: SessionID.descending(),
        turnID: MessageID.ascending(),
        clientAttemptID: "attempt-1",
        stepIndex: 0,
      }),
    ).toEqual({})
  })
  test("names the slash command that opened the turn", () => {
    const base = {
      providerID: providerIdFor("openai"),
      sessionID: SessionID.descending(),
      turnID: MessageID.ascending(),
      clientAttemptID: "attempt-1",
      stepIndex: 0,
    }
    expect(jolliCodingAgentHeaders({ ...base, command: "review" })["x-jolli-command"]).toBe("review")
    expect(jolliCodingAgentHeaders(base)["x-jolli-command"]).toBeUndefined()
    expect(jolliCodingAgentHeaders({ ...base, command: "" })["x-jolli-command"]).toBeUndefined()
  })

  test("percent-encodes a command name so a non-ASCII one cannot make fetch reject the request", () => {
    const base = {
      providerID: providerIdFor("openai"),
      sessionID: SessionID.descending(),
      turnID: MessageID.ascending(),
      clientAttemptID: "attempt-1",
      stepIndex: 0,
    }
    const value = jolliCodingAgentHeaders({ ...base, command: "审查" })["x-jolli-command"]
    expect(value).toBe("%E5%AE%A1%E6%9F%A5")
    expect(() => new Headers({ "x-jolli-command": value })).not.toThrow()
    expect(decodeURIComponent(value)).toBe("审查")
    // A lone surrogate would make encodeURIComponent throw and fail the whole turn.
    expect(jolliCodingAgentHeaders({ ...base, command: "\ud800" })["x-jolli-command"]).toBe("%EF%BF%BD")
  })
  test("lists the reported MCP servers", () => {
    const base = {
      providerID: providerIdFor("openai"),
      sessionID: SessionID.descending(),
      turnID: MessageID.ascending(),
      clientAttemptID: "attempt-1",
      stepIndex: 0,
    }
    expect(jolliCodingAgentHeaders({ ...base, mcpServers: ["github", "my_server"] })["x-jolli-mcp-servers"]).toBe(
      "github,my_server",
    )
    expect(jolliCodingAgentHeaders({ ...base, mcpServers: [] })["x-jolli-mcp-servers"]).toBeUndefined()
    expect(jolliCodingAgentHeaders(base)["x-jolli-mcp-servers"]).toBeUndefined()
  })

  test("percent-encodes each non-MCP tool name so a non-ASCII or comma name cannot break the header", () => {
    const base = {
      providerID: providerIdFor("openai"),
      sessionID: SessionID.descending(),
      turnID: MessageID.ascending(),
      clientAttemptID: "attempt-1",
      stepIndex: 0,
    }
    const value = jolliCodingAgentHeaders({ ...base, nonMcpTools: ["plan_exit", "plan_导出", "plan_a,b"] })[
      "x-jolli-non-mcp-tools"
    ]
    expect(value).toBe("plan_exit,plan_%E5%AF%BC%E5%87%BA,plan_a%2Cb")
    expect(() => new Headers({ "x-jolli-non-mcp-tools": value })).not.toThrow()
    expect(value.split(",").map(decodeURIComponent)).toEqual(["plan_exit", "plan_导出", "plan_a,b"])
    expect(jolliCodingAgentHeaders({ ...base, nonMcpTools: [] })["x-jolli-non-mcp-tools"]).toBeUndefined()
    expect(jolliCodingAgentHeaders(base)["x-jolli-non-mcp-tools"]).toBeUndefined()
  })

  test("reports the failed tool results, or none, only when the request carries a tool result", () => {
    const base = {
      providerID: providerIdFor("openai"),
      sessionID: SessionID.descending(),
      turnID: MessageID.ascending(),
      clientAttemptID: "attempt-1",
      stepIndex: 1,
    }
    expect(jolliCodingAgentHeaders({ ...base, toolErrors: ["call_1", "fc:2"] })["x-jolli-tool-errors"]).toBe(
      "call_1,fc%3A2",
    )
    expect(jolliCodingAgentHeaders({ ...base, toolErrors: [] })["x-jolli-tool-errors"]).toBe("none")
    expect(jolliCodingAgentHeaders(base)["x-jolli-tool-errors"]).toBeUndefined()
  })
})

describe("jolliToolErrors", () => {
  function result(toolCallId: string, type: "text" | "json" | "error-text" | "error-json") {
    return {
      type: "tool-result" as const,
      toolCallId,
      toolName: "github_list",
      output: type === "text" || type === "error-text" ? { type, value: "out" } : { type, value: { ok: false } },
    }
  }

  test("names the tool results the Anthropic SDK would flag as errors", () => {
    expect(
      jolliToolErrors([
        { role: "user", content: "go" },
        { role: "tool", content: [result("a", "text"), result("b", "error-text")] },
        { role: "tool", content: [result("c", "json"), result("d", "error-json")] },
      ]),
    ).toEqual(["b", "d"])
  })

  test("says none failed apart from carrying no tool result at all", () => {
    expect(jolliToolErrors([{ role: "tool", content: [result("a", "text")] }])).toEqual([])
    expect(jolliToolErrors([{ role: "user", content: "go" }])).toBeUndefined()
  })

  test("keeps the most recent failures when more failed than the backend keeps", () => {
    const ids = Array.from({ length: 40 }, (_, i) => `call_${i}`)
    expect(jolliToolErrors([{ role: "tool", content: ids.map((id) => result(id, "error-text")) }])).toEqual(
      ids.slice(-32),
    )
  })
})

describe("jolliMcpReport", () => {
  test("reports a server only when one of its MCP tools is offered", () => {
    expect(
      jolliMcpReport({
        toolNames: ["bash", "github_list"],
        mcpToolServers: new Map([
          ["github_list", "github"],
          ["hidden_lookup", "hidden"],
        ]),
      }).mcpServers,
    ).toEqual(["github"])
  })

  test("does not report a server whose name prefixes another offered server", () => {
    // Every github_* tool is denied; only github_enterprise's tool is offered.
    expect(
      jolliMcpReport({
        toolNames: ["github_enterprise_search"],
        mcpToolServers: new Map([
          ["github_list", "github"],
          ["github_enterprise_search", "github_enterprise"],
        ]),
      }),
    ).toEqual({ mcpServers: ["github_enterprise"], nonMcpTools: [] })
  })

  test("names the non-MCP tools that carry a reported server's prefix", () => {
    expect(
      jolliMcpReport({
        toolNames: ["bash", "plan_create", "plan_exit", "github_helper", "github_list"],
        mcpToolServers: new Map([
          ["github_list", "github"],
          ["plan_create", "plan"],
        ]),
      }),
    ).toEqual({ mcpServers: ["github", "plan"], nonMcpTools: ["github_helper", "plan_exit"] })
  })

  test("reports nothing without MCP tools in the request", () => {
    expect(jolliMcpReport({ toolNames: ["bash", "plan_exit"] })).toEqual({ mcpServers: [], nonMcpTools: [] })
    expect(jolliMcpReport({ toolNames: ["bash"], mcpToolServers: new Map([["github_list", "github"]]) })).toEqual({
      mcpServers: [],
      nonMcpTools: [],
    })
  })
})
