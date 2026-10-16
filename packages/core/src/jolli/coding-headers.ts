import { isJolliProviderId } from "./gateway-config"

/**
 * ⚠ A COMPACTION NAMES ITS SESSION AND NOTHING ELSE. It is no step of a turn, so it carries none of a
 * turn's headers; the gateway reads its session only to rewrite the history it summarises with the
 * placeholders that session's personal data already has.
 */
export function jolliCodingAgentHeaders(input: {
  readonly providerID: string
  readonly sessionID: string
  readonly requestKind?: "compaction"
  readonly parentSessionID?: string
  readonly turnID?: string
  readonly clientAttemptID?: string
  readonly stepIndex?: number
  readonly courseID?: string
  readonly courseAssistantID?: string
  /** The catalogue id of the model this request runs on; the body carries only its name. */
  readonly modelID?: string
  readonly continuesTurn?: boolean
  readonly command?: string
  readonly mcpServers?: ReadonlyArray<string>
  readonly mcpToolOverrides?: ReadonlyArray<readonly [tool: string, server: string]>
  readonly toolErrors?: ReadonlyArray<string>
}): Record<string, string> {
  if (!isJolliProviderId(input.providerID)) return {}
  if (input.requestKind === "compaction")
    return { "x-jolli-conversation-id": input.sessionID, "x-jolli-request-kind": input.requestKind }
  if (input.turnID === undefined || input.clientAttemptID === undefined || input.stepIndex === undefined) return {}
  return {
    "x-jolli-conversation-id": input.sessionID,
    "x-jolli-turn-id": input.turnID,
    "x-jolli-attempt-id": input.clientAttemptID,
    "x-jolli-request-id": `${input.clientAttemptID}:${input.stepIndex}`,
    "x-jolli-step-index": String(input.stepIndex),
    ...(input.courseID ? { "x-jolli-space-id": input.courseID } : {}),
    ...(input.courseAssistantID ? { "x-jolli-assistant-id": input.courseAssistantID } : {}),
    // The session remembers which catalogue row ran it, so the web chat's model picker opens on that
    // model. The name in the body cannot say: several rows may share one name.
    ...(input.modelID ? { "x-jolli-model-id": input.modelID } : {}),
    // The gateway decides a course-bound turn from its user message; a turn compaction opened to
    // carry on has none of the student's, so the gateway keeps the rule of the turn it continues.
    ...(input.continuesTurn ? { "x-jolli-turn-continues": "1" } : {}),
    ...(input.parentSessionID ? { "x-jolli-parent-session-id": input.parentSessionID } : {}),
    // Stats only: which slash command produced this turn's user message. Percent-encoded because
    // a command is named after a file or skill and may be non-ASCII, which fetch refuses in a
    // header value; the backend decodes it and drops anything it cannot validate. toWellFormed()
    // first, since encodeURIComponent throws on a lone surrogate.
    ...(input.command ? { "x-jolli-command": encodeURIComponent(input.command.toWellFormed()) } : {}),
    // Sanitized names are plain ASCII with no comma, so the list needs no encoding.
    ...(input.mcpServers?.length ? { "x-jolli-mcp-servers": input.mcpServers.join(",") } : {}),
    // Tool names are percent-encoded: a plugin or custom tool is named after a file and may be
    // non-ASCII or contain a comma or "=". An empty server marks a tool that is not MCP.
    ...(input.mcpToolOverrides?.length
      ? {
          "x-jolli-mcp-tool-overrides": input.mcpToolOverrides
            .map(([tool, server]) => `${encodeURIComponent(tool.toWellFormed())}=${server}`)
            .join(","),
        }
      : {}),
    // Sent whenever the request carries a tool result for the first time, as "none" when none failed,
    // so the backend can tell "nothing failed" from a client that does not report. Encoded like the
    // override tool names; a name repeats once per failed call.
    ...(input.toolErrors
      ? {
          "x-jolli-tool-errors": input.toolErrors.length
            ? input.toolErrors.map((name) => encodeURIComponent(name.toWellFormed())).join(",")
            : "none",
        }
      : {}),
  }
}
