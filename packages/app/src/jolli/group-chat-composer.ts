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
 * The draft with dictated `text` written after it. A space keeps it apart from what is already written,
 * unless the draft is empty or either side already has one there. Offsets continue from what is already
 * written; cursor and mention edits rely on them.
 */
export function groupChatDictation(
  prompt: PromptInputV2PersistedState["prompt"],
  text: string,
): PromptInputV2PersistedState["prompt"] {
  if (!text) return prompt
  const written = prompt.map((part) => ("content" in part ? part.content : "")).join("")
  const content = written && !/\s$/.test(written) && !/^\s/.test(text) ? ` ${text}` : text
  return [...prompt, { type: "text", content, start: written.length, end: written.length + content.length }]
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

/**
 * The request a send goes out as. A send whose answer was lost keeps its request id, and an identical
 * send reuses it so the server keeps one copy. Identical means the same draft, files, mentions, model and
 * recipient: sending to the group instead of asking an agent is another message, under another id.
 */
export function groupChatSendRequest(
  pending: { signature: string; body: Jolli.GroupChatPost } | undefined,
  prompt: PromptInputV2PersistedState["prompt"],
  next: Jolli.GroupChatPost,
  groupOnly: boolean,
) {
  const signature = JSON.stringify({
    prompt,
    groupOnly,
    attachmentIds: next.attachmentIds,
    pinnedMaterialIds: next.pinnedMaterialIds,
    mentionedAssistantId: next.mentionedAssistantId,
    mentionedUserIds: next.mentionedUserIds,
    mentionsAll: next.mentionsAll,
    modelId: next.modelId,
  })
  return { signature, body: pending?.signature === signature ? pending.body : next }
}
