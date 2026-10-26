import { createHash } from "node:crypto"
import { isJolliProviderId } from "./gateway-config"
import { orgScopeHeaders, parseCourseBinding } from "./org-scoped-id"

/** Optional UX capability; older gateways ignore it and newer gateways still accept older clients. */
export const JOLLI_CODE_PARTICIPATION_HEADER = "x-jolli-assignment-participation"
export const JOLLI_CODE_PARTICIPATION_VERSION = "1"

/** Root user text is preserved byte-for-byte by the V2 provider adapters. Synthetic context is omitted. */
export function jolliInputTextHeader(text: string | undefined): string {
  return text === undefined || text.trim() === "" ? "none" : createHash("sha256").update(text, "utf8").digest("hex")
}

export const CODING_CONTINUATION =
  "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."

/**
 * Merges request headers over a provider's static ones. Header names are case-insensitive, so a static
 * `X-Tenant-Slug` must go when the request names `x-tenant-slug`; left in, a plain object holds both
 * and the transport joins them into "home, target".
 */
export function overrideHeaders(
  base: Record<string, string>,
  override: Record<string, string>,
): Record<string, string> {
  const names = new Set(Object.keys(override).map((name) => name.toLowerCase()))
  return {
    ...Object.fromEntries(Object.entries(base).filter(([name]) => !names.has(name.toLowerCase()))),
    ...override,
  }
}

/**
 * ⚠ A COMPACTION NAMES ITS SESSION AND THE ORG IT LIVES IN, NOTHING ELSE. It is no step of a turn, so
 * it carries none of a turn's headers; the gateway reads its session only to rewrite the history it
 * summarises with the placeholders that session's personal data already has. That session lives in
 * the org its course binding names, so the scope goes with it; an unbound or bare session names none.
 */
export function jolliCodingAgentHeaders(input: {
  readonly providerID: string
  readonly sessionID: string
  readonly requestKind?: "compaction"
  readonly parentSessionID?: string
  readonly turnID?: string
  readonly clientAttemptID?: string
  readonly stepIndex?: number
  readonly assistantMessageID?: string
  readonly courseID?: string
  readonly courseAssistantID?: string
  /** The catalogue id of the model this request runs on; the body carries only its name. */
  readonly modelID?: string
  readonly continuesTurn?: boolean
  readonly command?: string
  readonly mcpServers?: ReadonlyArray<string>
  readonly mcpToolOverrides?: ReadonlyArray<readonly [tool: string, server: string]>
  readonly toolErrors?: ReadonlyArray<string>
  readonly skillMessageIds?: ReadonlyArray<number>
}): Record<string, string> {
  if (!isJolliProviderId(input.providerID)) return {}
  // The course and assistant are one binding, read whole: half of one, or a pair naming two orgs,
  // names no course and no org, since half a scope would address the right number in the wrong org.
  const scope =
    input.courseID !== undefined && input.courseAssistantID !== undefined
      ? parseCourseBinding({ courseId: input.courseID, assistantId: input.courseAssistantID })
      : undefined
  if (input.requestKind === "compaction")
    return {
      "x-jolli-conversation-id": input.sessionID,
      "x-jolli-request-kind": input.requestKind,
      ...orgScopeHeaders(scope?.org),
    }
  if (input.turnID === undefined || input.clientAttemptID === undefined || input.stepIndex === undefined) return {}
  return {
    [JOLLI_CODE_PARTICIPATION_HEADER]: JOLLI_CODE_PARTICIPATION_VERSION,
    "x-jolli-conversation-id": input.sessionID,
    "x-jolli-turn-id": input.turnID,
    "x-jolli-attempt-id": input.clientAttemptID,
    "x-jolli-request-id": `${input.clientAttemptID}:${input.stepIndex}`,
    "x-jolli-step-index": String(input.stepIndex),
    ...(input.assistantMessageID ? { "x-jolli-assistant-message-id": input.assistantMessageID } : {}),
    ...(input.skillMessageIds?.length ? { "x-jolli-skill-message-ids": input.skillMessageIds.join(",") } : {}),
    ...(scope
      ? { "x-jolli-space-id": String(scope.courseId), "x-jolli-assistant-id": String(scope.assistantId) }
      : /**
         * ⚠ A BINDING THAT DOES NOT PARSE GOES AS WRITTEN, WITH NO ORG — NEVER LEFT OFF. The gateway
         * refuses ids it does not hold, which the student sees; dropping them would run the turn as an
         * unbound chat, outside the course's rules, and nobody would be told. Create and PATCH refuse
         * such a binding, so this is the backstop for one that got stored some other way.
         */
        {
          ...(input.courseID ? { "x-jolli-space-id": input.courseID } : {}),
          ...(input.courseAssistantID ? { "x-jolli-assistant-id": input.courseAssistantID } : {}),
        }),
    ...orgScopeHeaders(scope?.org),
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
