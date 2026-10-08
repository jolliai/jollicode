import type { Prompt } from "@/context/prompt"
import type { SelectedLineRange } from "@/context/file"

const DEFAULT_PROMPT: Prompt = [{ type: "text", content: "", start: 0, end: 0 }]

/** Per chat, matching the TUI's own history depth. */
export const MAX_HISTORY = 50

/**
 * ⚠ HISTORY IS KEYED BY THE CHAT IT WAS TYPED IN, NOT BY THE WINDOW. One shared list meant ↑ in a
 * brand-new chat replayed whatever had been sent in some *other* chat, which reads as the composer
 * resurrecting a stranger's prompt. Scopes keep the arrow keys walking the current conversation.
 *
 * ⚠ THE TWO CAPS MULTIPLY, AND THE WHOLE DOCUMENT IS REWRITTEN ON EVERY SUBMIT. Persistence stores
 * all scopes as one JSON value, so the ceiling here is how much gets re-serialized each time a
 * prompt is sent — prompts can be pasted logs. Ten chats deep is far more than ↑ is ever walked.
 */
export const MAX_HISTORY_SCOPES = 10

export type PromptHistoryScopes = Record<string, PromptHistoryStoredEntry[]>

export type PromptHistoryComment = {
  id: string
  path: string
  selection: SelectedLineRange
  comment: string
  time: number
  origin?: "review" | "file"
  preview?: string
}

export type PromptHistoryEntry = {
  prompt: Prompt
  comments: PromptHistoryComment[]
}

export type PromptHistoryStoredEntry = Prompt | PromptHistoryEntry

export function canNavigateHistoryAtCursor(direction: "up" | "down", text: string, cursor: number, inHistory = false) {
  const position = Math.max(0, Math.min(cursor, text.length))
  const atStart = position === 0
  const atEnd = position === text.length
  if (inHistory) return atStart || atEnd
  if (direction === "up") return position === 0 && text.length === 0
  return position === text.length
}

export function clonePromptParts(prompt: Prompt): Prompt {
  return prompt.map((part) => {
    if (part.type === "text") return { ...part }
    if (part.type === "image") return { ...part }
    if (part.type === "agent") return { ...part }
    return {
      ...part,
      selection: part.selection ? { ...part.selection } : undefined,
    }
  })
}

function cloneSelection(selection: SelectedLineRange): SelectedLineRange {
  return {
    start: selection.start,
    end: selection.end,
    ...(selection.side ? { side: selection.side } : {}),
    ...(selection.endSide ? { endSide: selection.endSide } : {}),
  }
}

export function clonePromptHistoryComments(comments: PromptHistoryComment[]) {
  return comments.map((comment) => ({
    ...comment,
    selection: cloneSelection(comment.selection),
  }))
}

export function normalizePromptHistoryEntry(entry: PromptHistoryStoredEntry): PromptHistoryEntry {
  if (Array.isArray(entry)) {
    return {
      prompt: clonePromptParts(entry),
      comments: [],
    }
  }
  return {
    prompt: clonePromptParts(entry.prompt),
    comments: clonePromptHistoryComments(entry.comments),
  }
}

export function promptLength(prompt: Prompt) {
  return prompt.reduce((len, part) => len + ("content" in part ? part.content.length : 0), 0)
}

export function prependHistoryEntry(
  entries: PromptHistoryStoredEntry[],
  prompt: Prompt,
  comments: PromptHistoryComment[] = [],
  max = MAX_HISTORY,
) {
  const text = prompt
    .map((part) => ("content" in part ? part.content : ""))
    .join("")
    .trim()
  const hasImages = prompt.some((part) => part.type === "image")
  const hasComments = comments.some((comment) => !!comment.comment.trim())
  if (!text && !hasImages && !hasComments) return entries

  const entry = {
    prompt: clonePromptParts(prompt),
    comments: clonePromptHistoryComments(comments),
  } satisfies PromptHistoryEntry
  const last = entries[0]
  if (last && isPromptEqual(last, entry)) return entries
  return [entry, ...entries].slice(0, max)
}

export function sessionHistoryScope(sessionID: string) {
  return `session:${sessionID}`
}

/**
 * The composer of a chat that has no session yet. Submitting promotes this bucket into the session
 * the submit created, so the very first prompt stays recallable — and the next new chat starts empty
 * instead of inheriting it.
 *
 * ⚠ THE DRAFT TAB, NOT THE DIRECTORY, IS THE UNIT OF "A NEW CHAT". Several drafts can be open on
 * one folder at once, each with its own prompt text (see `Persist.draft`). Keyed by directory alone
 * they would share a bucket, and whichever submitted first would promote the others' typed prompts
 * into its session — the same leak between chats this scoping exists to stop, one level down. A
 * composer with no draft of its own still falls back to the directory.
 */
export function pendingHistoryScope(directory: string, draftID?: string) {
  return draftID ? `draft:${draftID}` : `new:${directory}`
}

export function promptHistoryScope(sessionID: string | undefined, directory: string, draftID?: string) {
  return sessionID ? sessionHistoryScope(sessionID) : pendingHistoryScope(directory, draftID)
}

// Insertion order is recency: the scope written last sits last, so trimming drops the stalest chats.
function touchScope(
  scopes: PromptHistoryScopes,
  scope: string,
  entries: PromptHistoryStoredEntry[],
  maxScopes: number,
) {
  const next = Object.entries(scopes)
    .filter(([key]) => key !== scope)
    .concat([[scope, entries]])
  return Object.fromEntries(next.slice(-maxScopes))
}

export function prependScopedHistoryEntry(
  scopes: PromptHistoryScopes,
  scope: string,
  prompt: Prompt,
  comments: PromptHistoryComment[] = [],
  max = MAX_HISTORY,
  maxScopes = MAX_HISTORY_SCOPES,
) {
  const current = scopes[scope] ?? []
  const next = prependHistoryEntry(current, prompt, comments, max)
  if (next === current) return scopes
  return touchScope(scopes, scope, next, maxScopes)
}

/**
 * Forgets a scope outright. Used when a submit fails to create its session: the pending bucket would
 * otherwise survive, and the next new chat would replay it — the very leak scoping exists to stop.
 */
export function dropHistoryScope(scopes: PromptHistoryScopes, scope: string) {
  if (!(scope in scopes)) return scopes
  return Object.fromEntries(Object.entries(scopes).filter(([key]) => key !== scope))
}

export function promoteHistoryScope(scopes: PromptHistoryScopes, from: string, to: string, max = MAX_HISTORY) {
  if (from === to) return scopes
  if (!(from in scopes)) return scopes

  const rest = Object.entries(scopes).filter(([key]) => key !== from && key !== to)
  const merged = [...(scopes[from] ?? []), ...(scopes[to] ?? [])].slice(0, max)
  // `to` lands last: it is the chat just written to, and order is what the scope cap evicts by.
  return Object.fromEntries(merged.length > 0 ? rest.concat([[to, merged]]) : rest)
}

function isCommentEqual(commentA: PromptHistoryComment, commentB: PromptHistoryComment) {
  return (
    commentA.path === commentB.path &&
    commentA.comment === commentB.comment &&
    commentA.origin === commentB.origin &&
    commentA.preview === commentB.preview &&
    commentA.selection.start === commentB.selection.start &&
    commentA.selection.end === commentB.selection.end &&
    commentA.selection.side === commentB.selection.side &&
    commentA.selection.endSide === commentB.selection.endSide
  )
}

function isPromptEqual(promptA: PromptHistoryStoredEntry, promptB: PromptHistoryStoredEntry) {
  const entryA = normalizePromptHistoryEntry(promptA)
  const entryB = normalizePromptHistoryEntry(promptB)
  if (entryA.prompt.length !== entryB.prompt.length) return false
  for (let i = 0; i < entryA.prompt.length; i++) {
    const partA = entryA.prompt[i]
    const partB = entryB.prompt[i]
    if (partA.type !== partB.type) return false
    if (partA.type === "text" && partA.content !== (partB.type === "text" ? partB.content : "")) return false
    if (partA.type === "file") {
      if (partA.path !== (partB.type === "file" ? partB.path : "")) return false
      const a = partA.selection
      const b = partB.type === "file" ? partB.selection : undefined
      const sameSelection =
        (!a && !b) ||
        (!!a &&
          !!b &&
          a.startLine === b.startLine &&
          a.startChar === b.startChar &&
          a.endLine === b.endLine &&
          a.endChar === b.endChar)
      if (!sameSelection) return false
    }
    if (partA.type === "agent" && partA.name !== (partB.type === "agent" ? partB.name : "")) return false
    if (partA.type === "image" && partA.id !== (partB.type === "image" ? partB.id : "")) return false
  }
  if (entryA.comments.length !== entryB.comments.length) return false
  for (let i = 0; i < entryA.comments.length; i++) {
    const commentA = entryA.comments[i]
    const commentB = entryB.comments[i]
    if (!commentA || !commentB || !isCommentEqual(commentA, commentB)) return false
  }
  return true
}

type HistoryNavInput = {
  direction: "up" | "down"
  entries: PromptHistoryStoredEntry[]
  historyIndex: number
  currentPrompt: Prompt
  currentComments: PromptHistoryComment[]
  savedPrompt: PromptHistoryEntry | null
}

type HistoryNavResult =
  | {
      handled: false
      historyIndex: number
      savedPrompt: PromptHistoryEntry | null
    }
  | {
      handled: true
      historyIndex: number
      savedPrompt: PromptHistoryEntry | null
      entry: PromptHistoryEntry
      cursor: "start" | "end"
    }

export function navigatePromptHistory(input: HistoryNavInput): HistoryNavResult {
  if (input.direction === "up") {
    if (input.entries.length === 0) {
      return {
        handled: false,
        historyIndex: input.historyIndex,
        savedPrompt: input.savedPrompt,
      }
    }

    if (input.historyIndex === -1) {
      const entry = normalizePromptHistoryEntry(input.entries[0])
      return {
        handled: true,
        historyIndex: 0,
        savedPrompt: {
          prompt: clonePromptParts(input.currentPrompt),
          comments: clonePromptHistoryComments(input.currentComments),
        },
        entry,
        cursor: "start",
      }
    }

    if (input.historyIndex < input.entries.length - 1) {
      const next = input.historyIndex + 1
      const entry = normalizePromptHistoryEntry(input.entries[next])
      return {
        handled: true,
        historyIndex: next,
        savedPrompt: input.savedPrompt,
        entry,
        cursor: "start",
      }
    }

    return {
      handled: false,
      historyIndex: input.historyIndex,
      savedPrompt: input.savedPrompt,
    }
  }

  if (input.historyIndex > 0) {
    const next = input.historyIndex - 1
    const entry = normalizePromptHistoryEntry(input.entries[next])
    return {
      handled: true,
      historyIndex: next,
      savedPrompt: input.savedPrompt,
      entry,
      cursor: "end",
    }
  }

  if (input.historyIndex === 0) {
    if (input.savedPrompt) {
      return {
        handled: true,
        historyIndex: -1,
        savedPrompt: null,
        entry: input.savedPrompt,
        cursor: "end",
      }
    }

    return {
      handled: true,
      historyIndex: -1,
      savedPrompt: null,
      entry: {
        prompt: DEFAULT_PROMPT,
        comments: [],
      },
      cursor: "end",
    }
  }

  return {
    handled: false,
    historyIndex: input.historyIndex,
    savedPrompt: input.savedPrompt,
  }
}
