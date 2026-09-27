import { describe, expect, test } from "bun:test"
import { Brand } from "@opencode-ai/core/brand"
import { providerIdFor, SUPPORTED_PROTOCOLS } from "@opencode-ai/core/jolli/gateway-config"
import { jolliCodingAgentHeaders, jolliMcpReport, jolliToolErrors } from "@/session/llm/request"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionV1 } from "@opencode-ai/core/v1/session"

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

  test("percent-encodes each override's tool name so a non-ASCII, comma or = name cannot break the header", () => {
    const base = {
      providerID: providerIdFor("openai"),
      sessionID: SessionID.descending(),
      turnID: MessageID.ascending(),
      clientAttemptID: "attempt-1",
      stepIndex: 0,
    }
    const value = jolliCodingAgentHeaders({
      ...base,
      mcpToolOverrides: [
        ["github_enterprise_list", "github"],
        ["plan_导出", ""],
        ["plan_a,b=c", ""],
      ],
    })["x-jolli-mcp-tool-overrides"]
    expect(value).toBe("github_enterprise_list=github,plan_%E5%AF%BC%E5%87%BA=,plan_a%2Cb%3Dc=")
    expect(() => new Headers({ "x-jolli-mcp-tool-overrides": value })).not.toThrow()
    expect(value.split(",").map((entry) => entry.split("=").map(decodeURIComponent))).toEqual([
      ["github_enterprise_list", "github"],
      ["plan_导出", ""],
      ["plan_a,b=c", ""],
    ])
    expect(jolliCodingAgentHeaders({ ...base, mcpToolOverrides: [] })["x-jolli-mcp-tool-overrides"]).toBeUndefined()
    expect(jolliCodingAgentHeaders(base)["x-jolli-mcp-tool-overrides"]).toBeUndefined()
  })

  test("reports the failed tool names, or none, only when the request carries a new tool result", () => {
    const base = {
      providerID: providerIdFor("openai"),
      sessionID: SessionID.descending(),
      turnID: MessageID.ascending(),
      clientAttemptID: "attempt-1",
      stepIndex: 1,
    }
    expect(
      jolliCodingAgentHeaders({ ...base, toolErrors: ["github_list", "github_list", "a,b"] })["x-jolli-tool-errors"],
    ).toBe("github_list,github_list,a%2Cb")
    expect(jolliCodingAgentHeaders({ ...base, toolErrors: [] })["x-jolli-tool-errors"]).toBe("none")
    expect(jolliCodingAgentHeaders(base)["x-jolli-tool-errors"]).toBeUndefined()
  })
})

describe("jolliToolErrors", () => {
  const sessionID = SessionID.descending()
  const model = { providerID: ProviderV2.ID.make(providerIdFor("openai")), modelID: ModelV2.ID.make("gpt") }

  function user(): SessionV1.WithParts {
    return {
      info: { id: MessageID.ascending(), sessionID, role: "user", time: { created: 0 }, agent: "build", model },
      parts: [],
    }
  }

  function assistant(...tools: Array<[tool: string, state: SessionV1.ToolPart["state"]]>): SessionV1.WithParts {
    const id = MessageID.ascending()
    return {
      info: {
        id,
        sessionID,
        parentID: MessageID.ascending(),
        role: "assistant",
        mode: "build",
        agent: "build",
        path: { cwd: "/", root: "/" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: model.modelID,
        providerID: model.providerID,
        time: { created: 0 },
      },
      parts: tools.map(([tool, state]) => ({
        id: PartID.ascending(),
        sessionID,
        messageID: id,
        type: "tool",
        callID: PartID.ascending(),
        tool,
        state,
      })),
    }
  }

  const time = { start: 0, end: 1 }
  const ok = { status: "completed", input: {}, output: "out", title: "", metadata: {}, time } as const
  const failed = (metadata?: Record<string, unknown>) =>
    ({ status: "error", input: {}, error: "boom", time, ...(metadata ? { metadata } : {}) }) as const

  test("names the failed tools of the latest assistant message", () => {
    expect(
      jolliToolErrors([
        user(),
        assistant(["github_list", ok], ["github_list", failed()], ["bash", failed()], ["github_search", ok]),
      ]),
    ).toEqual(["github_list", "bash"])
  })

  test("does not report a failure again once a later step has carried it", () => {
    const history = [user(), assistant(["github_list", failed()]), assistant()]
    expect(jolliToolErrors(history)).toBeUndefined()
    expect(jolliToolErrors([...history, user()])).toBeUndefined()
    expect(jolliToolErrors([...history, user(), assistant(["github_list", ok])])).toEqual([])
  })

  test("reports a failure the turn ended on with the next turn's first request", () => {
    expect(jolliToolErrors([user(), assistant(["github_list", failed()]), user()])).toEqual(["github_list"])
  })

  test("does not count a refused, aborted or unfinished call as a failure", () => {
    expect(
      jolliToolErrors([
        user(),
        assistant(
          ["github_list", failed({ rejected: true })],
          ["github_search", failed({ interrupted: true })],
          ["github_get", { status: "running", input: {}, time: { start: 0 } }],
        ),
      ]),
    ).toEqual([])
  })

  test("says none failed apart from carrying no tool result at all", () => {
    expect(jolliToolErrors([user(), assistant(["bash", ok])])).toEqual([])
    expect(jolliToolErrors([user(), assistant()])).toBeUndefined()
    expect(jolliToolErrors([user()])).toBeUndefined()
  })

  test("keeps the most recent failures when more failed than the backend keeps", () => {
    const names = Array.from({ length: 40 }, (_, i) => `tool_${i}`)
    expect(
      jolliToolErrors([assistant(...names.map((name): [string, SessionV1.ToolPart["state"]] => [name, failed()]))]),
    ).toEqual(names.slice(-32))
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
    ).toEqual({ mcpServers: ["github_enterprise"], mcpToolOverrides: [] })
  })

  test("overrides a tool the longest server prefix would give to the wrong server", () => {
    // github's own tool enterprise_list reads as github_enterprise's tool "list".
    expect(
      jolliMcpReport({
        toolNames: ["github_enterprise_list", "github_enterprise_search", "github_list"],
        mcpToolServers: new Map([
          ["github_enterprise_list", "github"],
          ["github_enterprise_search", "github_enterprise"],
          ["github_list", "github"],
        ]),
      }),
    ).toEqual({ mcpServers: ["github", "github_enterprise"], mcpToolOverrides: [["github_enterprise_list", "github"]] })
  })

  test("marks the non-MCP tools that carry a reported server's prefix", () => {
    expect(
      jolliMcpReport({
        toolNames: ["bash", "plan_create", "plan_exit", "github_helper", "github_list"],
        mcpToolServers: new Map([
          ["github_list", "github"],
          ["plan_create", "plan"],
        ]),
      }),
    ).toEqual({
      mcpServers: ["github", "plan"],
      mcpToolOverrides: [
        ["github_helper", ""],
        ["plan_exit", ""],
      ],
    })
  })

  test("reports nothing without MCP tools in the request", () => {
    expect(jolliMcpReport({ toolNames: ["bash", "plan_exit"] })).toEqual({ mcpServers: [], mcpToolOverrides: [] })
    expect(jolliMcpReport({ toolNames: ["bash"], mcpToolServers: new Map([["github_list", "github"]]) })).toEqual({
      mcpServers: [],
      mcpToolOverrides: [],
    })
  })
})
