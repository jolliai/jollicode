import { describe, expect, test } from "bun:test"
import { Brand } from "@opencode-ai/core/brand"
import { providerIdFor, SUPPORTED_PROTOCOLS } from "@opencode-ai/core/jolli/gateway-config"
import { jolliCodingAgentHeaders, jolliMcpReport } from "@/session/llm/request"
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
  test("lists the connected MCP servers under the names their tools are prefixed with", () => {
    const base = {
      providerID: providerIdFor("openai"),
      sessionID: SessionID.descending(),
      turnID: MessageID.ascending(),
      clientAttemptID: "attempt-1",
      stepIndex: 0,
    }
    expect(
      jolliCodingAgentHeaders({ ...base, mcpServers: ["github", "my server", "github"] })["x-jolli-mcp-servers"],
    ).toBe("github,my_server")
    expect(jolliCodingAgentHeaders({ ...base, mcpServers: [] })["x-jolli-mcp-servers"]).toBeUndefined()
    expect(jolliCodingAgentHeaders(base)["x-jolli-mcp-servers"]).toBeUndefined()
  })
  test("lists the tools that are not MCP but share a reported server's prefix", () => {
    const base = {
      providerID: providerIdFor("openai"),
      sessionID: SessionID.descending(),
      turnID: MessageID.ascending(),
      clientAttemptID: "attempt-1",
      stepIndex: 0,
    }
    expect(
      jolliCodingAgentHeaders({ ...base, nonMcpTools: ["plan_exit", "github_helper", "plan_exit"] })[
        "x-jolli-non-mcp-tools"
      ],
    ).toBe("github_helper,plan_exit")
    expect(jolliCodingAgentHeaders({ ...base, nonMcpTools: [] })["x-jolli-non-mcp-tools"]).toBeUndefined()
    expect(jolliCodingAgentHeaders(base)["x-jolli-non-mcp-tools"]).toBeUndefined()
  })
})

describe("jolliMcpReport", () => {
  test("reports a server only when one of its MCP tools is offered", () => {
    expect(
      jolliMcpReport({
        toolNames: ["bash", "github_list", "plan_exit"],
        mcpServers: ["github", "plan", "hidden"],
        mcpToolNames: ["github_list", "plan_create", "hidden_lookup"],
      }).mcpServers,
    ).toEqual(["github"])
  })

  test("names the non-MCP tools that carry a reported server's prefix", () => {
    expect(
      jolliMcpReport({
        toolNames: ["bash", "plan_create", "plan_exit", "github_helper", "github_list"],
        mcpServers: ["github", "plan"],
        mcpToolNames: ["github_list", "plan_create"],
      }),
    ).toEqual({ mcpServers: ["github", "plan"], nonMcpTools: ["plan_exit", "github_helper"] })
  })

  test("matches servers by their sanitized name, as MCP tool names are built", () => {
    expect(
      jolliMcpReport({
        toolNames: ["my_server_lookup", "my_server_notes"],
        mcpServers: ["my server"],
        mcpToolNames: ["my_server_lookup"],
      }),
    ).toEqual({ mcpServers: ["my server"], nonMcpTools: ["my_server_notes"] })
  })

  test("reports nothing without MCP servers or tools", () => {
    expect(jolliMcpReport({ toolNames: ["bash", "plan_exit"] })).toEqual({ mcpServers: [], nonMcpTools: [] })
    expect(jolliMcpReport({ toolNames: ["github_list"], mcpServers: ["github"] })).toEqual({
      mcpServers: [],
      nonMcpTools: [],
    })
  })
})
