import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { Auth } from "@/auth"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceState } from "@/effect/instance-state"
import { Permission } from "@/permission"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "../message-v2"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { SystemPrompt } from "../system"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { isJolliProviderId } from "@opencode-ai/core/jolli/gateway-config"
import { Effect, Record } from "effect"
import { jsonSchema, tool as aiTool, type ModelMessage, type Tool } from "ai"
import type { Plugin } from "@/plugin"
import { mergeDeep } from "remeda"
import { McpCatalog } from "@/mcp/catalog"

const USER_AGENT = `opencode/${InstallationVersion}`

type PrepareInput = {
  readonly user: SessionV1.User
  readonly sessionID: string
  readonly parentSessionID?: string
  readonly turnID?: string
  readonly clientAttemptID?: string
  readonly stepIndex?: number
  readonly courseID?: string
  readonly courseAssistantID?: string
  readonly mcpServers?: ReadonlyArray<string>
  /** Every MCP tool name as MCP.tools() keys it, so a request's tools can be told apart exactly. */
  readonly mcpToolNames?: ReadonlyArray<string>
  readonly model: Provider.Model
  readonly agent: Agent.Info
  readonly permission?: PermissionV1.Ruleset
  readonly system: string[]
  readonly messages: ModelMessage[]
  readonly small?: boolean
  readonly tools: Record<string, Tool>
  readonly provider: Provider.Info
  readonly auth: Auth.Info | undefined
  readonly plugin: Plugin.Interface
  readonly flags: RuntimeFlags.Info
  readonly isWorkflow: boolean
}

export type Prepared = {
  readonly system: string[]
  readonly messages: ModelMessage[]
  readonly tools: Record<string, Tool>
  readonly params: {
    readonly temperature?: number
    readonly topP?: number
    readonly topK?: number
    readonly maxOutputTokens?: number
    readonly options: Record<string, any>
  }
  readonly messageTransformOptions: Record<string, any>
  readonly headers: Record<string, string>
}

export function jolliCodingAgentHeaders(input: {
  readonly providerID: string
  readonly sessionID: string
  readonly parentSessionID?: string
  readonly turnID?: string
  readonly clientAttemptID?: string
  readonly stepIndex?: number
  readonly courseID?: string
  readonly courseAssistantID?: string
  readonly command?: string
  readonly mcpServers?: ReadonlyArray<string>
  readonly nonMcpTools?: ReadonlyArray<string>
}): Record<string, string> {
  if (!isJolliProviderId(input.providerID)) return {}
  if (input.turnID === undefined || input.clientAttemptID === undefined || input.stepIndex === undefined) return {}
  // The same sanitize() MCP tool names are built with, so each entry is exactly the
  // `<server>_` prefix the backend matches tool calls against.
  const mcpServers = [...new Set((input.mcpServers ?? []).map(McpCatalog.sanitize))].filter(Boolean).toSorted()
  const nonMcpTools = [...new Set(input.nonMcpTools ?? [])].toSorted()
  return {
    "x-jolli-conversation-id": input.sessionID,
    "x-jolli-turn-id": input.turnID,
    "x-jolli-attempt-id": input.clientAttemptID,
    "x-jolli-request-id": `${input.clientAttemptID}:${input.stepIndex}`,
    "x-jolli-step-index": String(input.stepIndex),
    ...(input.courseID ? { "x-jolli-space-id": input.courseID } : {}),
    ...(input.courseAssistantID ? { "x-jolli-assistant-id": input.courseAssistantID } : {}),
    ...(input.parentSessionID ? { "x-jolli-parent-session-id": input.parentSessionID } : {}),
    // Stats only: which slash command produced this turn's user message. Percent-encoded because
    // a command is named after a file or skill and may be non-ASCII, which fetch refuses in a
    // header value; the backend decodes it and drops anything it cannot validate. toWellFormed()
    // first, since encodeURIComponent throws on a lone surrogate.
    ...(input.command ? { "x-jolli-command": encodeURIComponent(input.command.toWellFormed()) } : {}),
    ...(mcpServers.length > 0 ? { "x-jolli-mcp-servers": mcpServers.join(",") } : {}),
    // Tools that are not MCP but whose name reads as `<server>_<tool>` under a reported server — a
    // built-in like plan_exit beside a server named "plan", or a plugin or custom tool. Only this
    // client knows which of its tools are MCP, so it says so rather than the backend guessing.
    ...(nonMcpTools.length > 0 ? { "x-jolli-non-mcp-tools": nonMcpTools.join(",") } : {}),
  }
}

/**
 * What a Jolli request reports about MCP: the connected servers with an MCP tool among the
 * request's tools (so a permission-hidden server is not reported), and the request's non-MCP tools
 * that carry one of those servers' `<server>_` prefix.
 */
export function jolliMcpReport(input: {
  readonly toolNames: ReadonlyArray<string>
  readonly mcpServers?: ReadonlyArray<string>
  readonly mcpToolNames?: ReadonlyArray<string>
}): { readonly mcpServers: ReadonlyArray<string>; readonly nonMcpTools: ReadonlyArray<string> } {
  const mcpTools = new Set(input.mcpToolNames ?? [])
  const offered = input.toolNames.filter((name) => mcpTools.has(name))
  const mcpServers = (input.mcpServers ?? []).filter((server) =>
    offered.some((name) => name.startsWith(`${McpCatalog.sanitize(server)}_`)),
  )
  const prefixes = mcpServers.map((server) => `${McpCatalog.sanitize(server)}_`)
  const nonMcpTools = input.toolNames.filter(
    (name) => !mcpTools.has(name) && prefixes.some((prefix) => name.startsWith(prefix)),
  )
  return { mcpServers, nonMcpTools }
}

const mergeOptions = (target: Record<string, any>, source: Record<string, any> | undefined): Record<string, any> =>
  mergeDeep(target, source ?? {}) as Record<string, any>

export const prepare = Effect.fn("LLMRequestPrep.prepare")(function* (input: PrepareInput) {
  const isOpenaiOauth = input.provider.id === "openai" && input.auth?.type === "oauth"
  const system = [
    [
      ...(input.agent.prompt ? [input.agent.prompt] : SystemPrompt.provider(input.model)),
      ...input.system,
      ...(input.user.system ? [input.user.system] : []),
    ]
      .filter((x) => x)
      .join("\n"),
  ]

  const header = system[0]
  yield* input.plugin.trigger(
    "experimental.chat.system.transform",
    { sessionID: input.sessionID, model: input.model },
    { system },
  )
  if (system.length > 2 && system[0] === header) {
    const rest = system.slice(1)
    system.length = 0
    system.push(header, rest.join("\n"))
  }

  const variant =
    !input.small && input.model.variants && input.user.model.variant
      ? input.model.variants[input.user.model.variant]
      : {}
  const base = input.small
    ? ProviderTransform.smallOptions(input.model)
    : ProviderTransform.options({
        model: input.model,
        sessionID: input.sessionID,
        providerOptions: input.provider.options,
      })
  const options = mergeOptions(mergeOptions(mergeOptions(base, input.model.options), input.agent.options), variant)
  if (
    input.model.api.npm === "@ai-sdk/azure" &&
    (input.provider.options.useCompletionUrls || input.model.options.useCompletionUrls || options.useCompletionUrls)
  ) {
    delete options.reasoningSummary
    delete options.include
  }
  if (isOpenaiOauth) options.instructions = system.join("\n")

  const messages =
    isOpenaiOauth || input.isWorkflow
      ? input.messages
      : [
          ...system.map(
            (x): ModelMessage => ({
              role: "system",
              content: x,
            }),
          ),
          ...input.messages,
        ]

  const params = yield* input.plugin.trigger(
    "chat.params",
    {
      sessionID: input.sessionID,
      agent: input.agent.name,
      model: input.model,
      provider: input.provider,
      message: input.user,
    },
    {
      temperature: input.model.capabilities.temperature
        ? (input.agent.temperature ?? ProviderTransform.temperature(input.model))
        : undefined,
      topP: input.agent.topP ?? ProviderTransform.topP(input.model),
      topK: ProviderTransform.topK(input.model),
      maxOutputTokens: ProviderTransform.maxOutputTokens(input.model, input.flags.outputTokenMax),
      options,
    },
  )

  const { headers } = yield* input.plugin.trigger(
    "chat.headers",
    {
      sessionID: input.sessionID,
      agent: input.agent.name,
      model: input.model,
      provider: input.provider,
      message: input.user,
    },
    {
      headers: {},
    },
  )

  const tools = resolveTools(input)
  // Codex parity: OpenAI Responses-family providers hardcode `strict: false`
  // on every function tool so MCP-sourced and dynamic schemas that don't
  // satisfy OpenAI's structured-outputs constraints still register.
  if (
    input.model.api.npm === "@ai-sdk/openai" ||
    input.model.api.npm === "@ai-sdk/azure" ||
    input.model.api.npm === "@ai-sdk/amazon-bedrock/mantle"
  ) {
    for (const key of Object.keys(tools)) tools[key] = { ...tools[key], strict: false }
  }
  if (
    input.model.providerID.includes("github-copilot") &&
    Object.keys(tools).length === 0 &&
    hasToolCalls(input.messages)
  ) {
    // Copilot needs a tools field when replaying prior tool calls, even if no tools are currently enabled.
    tools["_noop"] = aiTool({
      description: "Do not call this tool. It exists only for API compatibility and must never be invoked.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          reason: { type: "string", description: "Unused" },
        },
      }),
      execute: async () => ({ output: "", title: "", metadata: {} }),
    })
  }

  const opencodeProjectID = input.model.providerID.startsWith("opencode")
    ? (yield* InstanceState.context).project.id
    : undefined

  return {
    system,
    messages,
    tools: Object.fromEntries(Object.entries(tools).toSorted(([a], [b]) => a.localeCompare(b))),
    params,
    messageTransformOptions: options,
    headers: {
      ...(input.model.providerID.startsWith("opencode")
        ? {
            ...(opencodeProjectID ? { "x-jollicode-project": opencodeProjectID } : {}),
            "x-jollicode-session": input.sessionID,
            "x-jollicode-request": input.user.id,
            "x-jollicode-client": input.flags.client,
            "User-Agent": USER_AGENT,
          }
        : {
            "x-session-affinity": input.sessionID,
            "X-Session-Id": input.sessionID,
            "User-Agent": USER_AGENT,
          }),
      ...(input.parentSessionID ? { "x-parent-session-id": input.parentSessionID } : {}),
      ...input.model.headers,
      ...headers,
      ...jolliCodingAgentHeaders({
        providerID: input.model.providerID,
        sessionID: input.sessionID,
        parentSessionID: input.parentSessionID,
        turnID: input.turnID,
        clientAttemptID: input.clientAttemptID,
        stepIndex: input.stepIndex,
        courseID: input.courseID,
        courseAssistantID: input.courseAssistantID,
        command: input.user.command,
        ...jolliMcpReport({
          toolNames: Object.keys(tools),
          mcpServers: input.mcpServers,
          mcpToolNames: input.mcpToolNames,
        }),
      }),
    },
  }
})

function resolveTools(input: Pick<PrepareInput, "tools" | "agent" | "permission" | "user">) {
  const disabled = Permission.disabled(
    Object.keys(input.tools),
    Permission.merge(input.agent.permission, input.permission ?? []),
  )
  return Record.filter(input.tools, (_, k) => input.user.tools?.[k] !== false && !disabled.has(k))
}

export function hasToolCalls(messages: ModelMessage[]): boolean {
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content) {
      if (part.type === "tool-call" || part.type === "tool-result") return true
    }
  }
  return false
}

export * as LLMRequestPrep from "./request"
