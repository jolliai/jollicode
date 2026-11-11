import { Option, Schema } from "effect"
import type { Jolli } from "@opencode-ai/schema/jolli"
import { parseOrgScopedId } from "@opencode-ai/core/jolli/org-scoped-id"

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
const Locator = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("page"), page: PositiveInt, lastPage: PositiveInt.pipe(Schema.optional) }),
  Schema.Struct({ kind: Schema.Literal("heading"), path: Schema.Array(Schema.String).check(Schema.isMinLength(1)) }),
  Schema.Struct({ kind: Schema.Literal("timecode"), seconds: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)) }),
  Schema.Struct({ kind: Schema.Literal("ordinal"), index: PositiveInt, of: PositiveInt.pipe(Schema.optional) }),
])
const Source = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("material"),
    id: PositiveInt,
    title: Schema.String,
    locator: Locator.pipe(Schema.optional),
    studentAccess: Schema.String.pipe(Schema.optional),
    unavailable: Schema.Boolean.pipe(Schema.optional),
    replacedBy: PositiveInt.pipe(Schema.optional),
    sourceUrl: Schema.String.pipe(Schema.optional),
    linkTitle: Schema.String.pipe(Schema.optional),
    assignment: Schema.Struct({ courseId: PositiveInt }).pipe(Schema.optional),
  }),
  Schema.Struct({ kind: Schema.Literal("web"), url: Schema.String, title: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("student_work"),
    courseId: PositiveInt,
    assignmentId: PositiveInt,
    assignmentTitle: Schema.String.pipe(Schema.optional),
    taskId: PositiveInt.pipe(Schema.optional),
    task: Schema.String.pipe(Schema.optional),
    category: Schema.Literals(["record", "submission", "reflection", "feedback"]),
    sourceId: Schema.String,
    title: Schema.String,
  }),
])
export type GroupChatSource = typeof Source.Type
export type GroupChatLocator = typeof Locator.Type
export type GroupChatSourceGroup = { key: string; source: GroupChatSource; excerpts: GroupChatSource[] }

/** Group chat attribution comes only from served sources, never from prose or tool results. */
export function groupChatSourcesByMessage(messages: readonly Jolli.ChatMessage[]) {
  const turns = new Map<number, GroupChatSource[]>()
  const answers = new Map<number, Jolli.ChatMessage>()
  for (const message of messages) {
    if (message.role !== "assistant" || !message.content.trim()) continue
    answers.set(message.turnId, message)
    const payload = message.payload
    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      !("answerSources" in payload) ||
      !Array.isArray(payload.answerSources)
    )
      continue
    turns.set(
      message.turnId,
      payload.answerSources.flatMap((value) => {
        const source = Option.getOrUndefined(Schema.decodeUnknownOption(Source)(value))
        return source?.title.trim() ? [source] : []
      }),
    )
  }
  return new Map(
    [...answers].flatMap(([turnId, message]) => {
      const sources = turns.get(turnId)
      if (message.incomplete || message.content.startsWith("[ERROR]") || !sources?.length) return []
      return [[message.id, sources] as const]
    }),
  )
}

/** One document per card, with each distinct cited location kept inside that card. */
export function groupChatSourceGroups(sources: readonly GroupChatSource[]) {
  const groups = new Map<string, GroupChatSourceGroup>()
  const seen = new Set<string>()
  for (const source of sources) {
    const key =
      source.kind === "web"
        ? `web:${source.url}`
        : source.kind === "student_work"
          ? `assignment:${source.courseId}:${source.assignmentId}`
          : source.assignment
            ? `assignment:${source.assignment.courseId}:${source.id}`
            : `material:${source.id}`
    const group = groups.get(key)
    // Match web chat: every excerpt must permit access, and any unavailable excerpt locks the document.
    if (group?.source.kind === "material" && source.kind === "material") {
      group.source = {
        ...group.source,
        studentAccess: group.source.studentAccess === "download" ? source.studentAccess : group.source.studentAccess,
        unavailable: group.source.unavailable || source.unavailable,
      }
    }
    const identity = `${key}:${JSON.stringify(source.kind === "material" ? source.locator : source)}`
    if (seen.has(identity)) continue
    seen.add(identity)
    if (!group) {
      groups.set(key, {
        key,
        source: source.kind === "material" ? { ...source, locator: undefined } : source,
        excerpts: source.kind === "material" && !source.locator ? [] : source.kind === "web" ? [] : [source],
      })
      continue
    }
    if (source.kind !== "material" || source.locator) group.excerpts.push(source)
  }
  return [...groups.values()]
}

export function groupChatSourceUrl(source: GroupChatSource, chat: Jolli.GroupChat, staff: boolean) {
  if (source.kind === "web") return webUrl(source.url)
  if (source.kind === "material") {
    const successor = source.unavailable && !source.assignment ? source.replacedBy : undefined
    if (source.unavailable && !successor) return undefined
    if (!source.unavailable && source.sourceUrl) {
      const address = webUrl(source.sourceUrl)
      if (address) {
        const heading = source.locator?.kind === "heading" ? source.locator.path.at(-1)?.trim() : undefined
        if (heading) address.hash += `:~:text=${encodeURIComponent(heading).replaceAll("-", "%2D")}`
        return address
      }
    }
    if (!staff && !source.assignment && source.studentAccess !== "download" && !successor) return undefined
    const base = webUrl(chat.webBaseUrl)
    const course = parseOrgScopedId(chat.courseId)
    if (!base || !course) return undefined
    const prefix = staff ? "courses" : "learn"
    if (source.assignment)
      return new URL(
        `${base.href.replace(/\/$/, "")}/${prefix}/${source.assignment.courseId}/assignments/${source.id}${staff ? "/preview" : ""}`,
      )
    const url = new URL(`${base.href.replace(/\/$/, "")}/${prefix}/${course.id}/materials/${successor ?? source.id}`)
    if (!successor && source.locator?.kind === "page") url.searchParams.set("page", String(source.locator.page))
    if (!successor && source.locator?.kind === "heading")
      source.locator.path.forEach((heading) => url.searchParams.append("heading", heading))
    return url
  }
  const base = webUrl(chat.webBaseUrl)
  if (!base) return undefined
  const url = new URL(
    `${base.href.replace(/\/$/, "")}/${staff ? "courses" : "learn"}/${source.courseId}/assignments/${source.assignmentId}`,
  )
  if (source.taskId) url.hash = `task-${source.taskId}`
  return url
}

function webUrl(value: string | undefined) {
  if (!value || !URL.canParse(value)) return undefined
  const url = new URL(value)
  return url.protocol === "http:" || url.protocol === "https:" ? url : undefined
}
