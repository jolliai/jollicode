import type { Jolli } from "@opencode-ai/schema/jolli"
import type { PromptInputV2PersistedState } from "@opencode-ai/session-ui/v2/prompt-input"
import { orgScopedId, parseOrgScopedId } from "@opencode-ai/core/jolli/org-scoped-id"

export function groupChatRecipient(prompt: PromptInputV2PersistedState["prompt"], remembered: number | null = null) {
  const mentions = prompt.flatMap((part) => (part.type === "agent" ? [part.name] : []))
  const assistant = mentions.findLast((mention) => mention.startsWith("agent:"))
  if (assistant) return Number(assistant.slice(6))
  return mentions.length ? null : remembered
}

/** Use the same assistant address as direct chats, including other organizations. */
export function groupChatAssistantId(courseId: string, assistantId: number | null) {
  const course = parseOrgScopedId(courseId)
  if (!course || assistantId === null) return undefined
  return orgScopedId(course.org, assistantId)
}

/** Keeps only the selected agent's mentions, or removes them all, retaining people and attachments. */
export function groupChatTargetPrompt(prompt: PromptInputV2PersistedState["prompt"], assistantId?: number) {
  return prompt
    .filter((part) => part.type !== "agent" || !part.name.startsWith("agent:") || part.name === `agent:${assistantId}`)
    .reduce<PromptInputV2PersistedState["prompt"]>((parts, part) => {
      if (!("content" in part)) return [...parts, part]
      const start = parts.reduce((length, item) => length + ("content" in item ? item.content.length : 0), 0)
      return [...parts, { ...part, start, end: start + part.content.length }]
    }, [])
}

/**
 * The models an ask to `assistantId` may use, and the one it goes with: the person's remembered pick
 * while the assistant still grants it, else the assistant's own default, else the first it grants.
 *
 * Nothing is selected for a group message, or while the model list or the assistant's choices are
 * unavailable. The ask then goes without a model and the server answers with the assistant's
 * default, as web chat does; it is never blocked for want of one.
 */
export function groupChatModel(
  composer: Jolli.GroupChatFeatures["composer"],
  assistantId: number | null,
  preference?: string,
) {
  const assistant = composer?.assistants.find((agent) => agent.id === assistantId)
  const options = assistant
    ? (composer?.models ?? []).filter(
        (model) => !assistant.allowedModelIds.length || assistant.allowedModelIds.includes(model.id),
      )
    : []
  const selected = [preference, assistant?.modelId, options[0]?.id].find((id) =>
    options.some((model) => model.id === id),
  )
  return { options, selected }
}
