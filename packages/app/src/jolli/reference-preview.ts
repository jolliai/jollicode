import { Schema } from "effect"
import { Jolli } from "@opencode-ai/schema/jolli"
import { orgScopedId, parseOrgScopedId, parseGroupChatID } from "@opencode-ai/core/jolli/org-scoped-id"
import type { ServerSDK } from "@/context/server-sdk"
import type { GroupChatLocator, GroupChatSource } from "./group-chat-sources"
import { groupChatSourceUrl } from "./group-chat-sources"
import { groupChatFetch } from "./group-chat-media"
import { safeReferenceUrl } from "./external-link"

export type ReferencePreview = {
  target?: Jolli.ReferenceTarget
  key: string
  title: string
  reference: Jolli.Reference
  locator?: GroupChatLocator
  taskId?: number
  citedSource?: { category: "record" | "submission" | "reflection" | "feedback"; sourceId: string; title: string }
  mimeType?: string
  webPage?: boolean
  url?: string
}

export function scopedReferencePreview(target: Jolli.ReferenceTarget, item: ReferencePreview): ReferencePreview {
  const scope = item.target ?? target
  const prefix = `${JSON.stringify(scope)}:`
  return item.target && item.key.startsWith(prefix)
    ? item
    : { ...item, key: item.key.startsWith(prefix) ? item.key : `${prefix}${item.key}`, target: scope }
}

export function referenceCourseTarget(target: Jolli.ReferenceTarget, courseId: number): Jolli.ReferenceTarget {
  const scope =
    target.kind === "group"
      ? parseGroupChatID(target.chatID).scope
      : target.kind === "course"
        ? parseOrgScopedId(target.courseId)?.org
        : undefined
  return { kind: "course", courseId: orgScopedId(scope, courseId) }
}

export function referencePreviewOf(
  source: GroupChatSource,
  chat: Jolli.GroupChat,
  staff: boolean,
): ReferencePreview | undefined {
  const url = groupChatSourceUrl(source, chat, staff)
  if (!url || source.kind === "web" || (source.kind === "material" && source.sourceUrl && !source.unavailable))
    return undefined
  if (source.kind === "student_work")
    return {
      key: `assignment:${source.courseId}:${source.assignmentId}`,
      title: source.assignmentTitle ?? source.title,
      reference: { kind: "assignment", courseId: source.courseId, assignmentId: source.assignmentId, staffView: staff },
      taskId: source.taskId,
      citedSource: { category: source.category, sourceId: source.sourceId, title: source.title },
      url: url.href,
    }
  if (source.assignment)
    return {
      key: `assignment:${source.assignment.courseId}:${source.id}`,
      title: source.title,
      reference: {
        kind: "assignment",
        courseId: source.assignment.courseId,
        assignmentId: source.id,
        staffView: staff,
      },
      locator: source.locator,
      url: url.href,
    }
  const materialId = source.unavailable ? source.replacedBy! : source.id
  return {
    key: `material:${materialId}`,
    title: source.title,
    reference: { kind: "material", materialId },
    locator: source.unavailable ? undefined : source.locator,
    url: url.href,
  }
}

/** The server answered that this reference is gone or not the reader's to see; asking again will not change it. */
export class ReferenceUnavailableError extends Error {}

/** The sidecar answered that the Jolli credential is gone: nothing of the server's chats may stay in the window. */
export class ReferenceSignedOutError extends Error {}

/**
 * One read of a reference. Every failure throws; only an answer that the reference is gone or withheld
 * throws {@link ReferenceUnavailableError}: the chat gone, a 404 or 410, or a 403 that names no code,
 * which is the reference route's own refusal. A lost sign-in throws {@link ReferenceSignedOutError}, which
 * says nothing about the reference either but drops the window's chats of the server. Anything else may be
 * read again: no answer, the server out of reach, and a refusal that names a code, which turns the request
 * away rather than the reference (an org it could not be placed in, the school asking for a fresh sign-in,
 * a tenant the sign-in does not match).
 */
export async function readReference(
  sdk: ServerSDK,
  target: Jolli.ReferenceTarget,
  reference: Jolli.Reference,
  operation: Jolli.ReferenceRequest["operation"] = "read",
  signal?: AbortSignal,
) {
  const response = await groupChatFetch(sdk, "/jolli/reference", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target, reference, operation }),
    signal,
  })
  if (!response.ok) throw new Error("Reference request failed")
  const answer = Schema.decodeUnknownSync(Jolli.GroupChatAnswer)(await response.json())
  if (answer.status === "ok" && answer.resource !== undefined) return answer.resource
  if (answer.status === "signed-out") throw new ReferenceSignedOutError("Signed out of Jolli")
  // Only the server's own answer makes it final: a refusal carries its sentence (`message`) only when the body
  // was jolliedu's JSON, so a proxy's or firewall's 403/404 page stays something to try again.
  if (
    answer.status === "ok" ||
    answer.status === "revoked" ||
    (answer.status === "refused" &&
      answer.message !== undefined &&
      (answer.httpStatus === 404 ||
        answer.httpStatus === 410 ||
        (answer.httpStatus === 403 && answer.code === undefined)))
  )
    throw new ReferenceUnavailableError("Reference is unavailable")
  throw new Error("Reference request failed")
}

export const ReferenceMaterial = Schema.Struct({
  id: Schema.Int,
  title: Schema.String,
  origin: Schema.String,
  mimeType: Schema.NullOr(Schema.String),
  sizeBytes: Schema.NullOr(Schema.Number),
  url: Schema.String.pipe(Schema.optional),
  studentAccess: Schema.String.pipe(Schema.optional),
  state: Schema.String.pipe(Schema.optional),
  artifact: Schema.Struct({ id: Schema.String, kind: Schema.String, version: Schema.Int }).pipe(Schema.optional),
  webPage: Schema.Struct({
    url: Schema.String,
    expiresAt: Schema.String,
    owner: Schema.String.pipe(Schema.optional),
  }).pipe(Schema.optional),
  notOnSite: Schema.Struct({ text: Schema.String, truncated: Schema.Boolean.pipe(Schema.optional) }).pipe(
    Schema.optional,
  ),
  storedCopy: Schema.Json.pipe(Schema.optional),
  map: Schema.Struct({ phase: Schema.String, topics: Schema.Number.pipe(Schema.optional) }).pipe(Schema.optional),
})
export type ReferenceMaterial = typeof ReferenceMaterial.Type
const ReferenceHandInFile = Schema.Struct({
  id: Schema.Int,
  filename: Schema.String,
  sizeBytes: Schema.Number,
  status: Schema.String,
  webPage: Schema.Boolean.pipe(Schema.optional),
})
const ReferenceHandInDoc = Schema.Struct({
  id: Schema.Int.pipe(Schema.optional),
  position: Schema.Int.pipe(Schema.optional),
  name: Schema.String,
})
const ReferenceSubmission = Schema.Struct({
  submissionId: Schema.Int.pipe(Schema.optional),
  summary: Schema.NullOr(Schema.String).pipe(Schema.optional),
  reflection: Schema.NullOr(Schema.String).pipe(Schema.optional),
  staffComment: Schema.NullOr(Schema.String).pipe(Schema.optional),
  files: Schema.Array(ReferenceHandInFile).pipe(Schema.optional),
  docs: Schema.Array(ReferenceHandInDoc).pipe(Schema.optional),
})
export const ReferenceAssignment = Schema.Struct({
  id: Schema.Int,
  courseId: Schema.Int,
  title: Schema.String,
  description: Schema.String,
  worksheet: Schema.String,
  dueAt: Schema.NullOr(Schema.String),
  overallComment: Schema.NullOr(Schema.String).pipe(Schema.optional),
  parts: Schema.Array(
    Schema.Struct({
      id: Schema.Int,
      kind: Schema.String,
      name: Schema.String,
      cardKey: Schema.String,
      position: Schema.Int,
      reflectionPrompt: Schema.NullOr(Schema.String).pipe(Schema.optional),
      lastReviewComment: Schema.NullOr(Schema.String).pipe(Schema.optional),
      assistantBlurb: Schema.String.pipe(Schema.optional),
      submission: Schema.NullOr(ReferenceSubmission).pipe(Schema.optional),
      files: Schema.Array(ReferenceHandInFile).pipe(Schema.optional),
      docs: Schema.Array(ReferenceHandInDoc).pipe(Schema.optional),
    }),
  ),
})
export const ReferenceArtifact = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  kind: Schema.String,
  currentVersion: Schema.NullOr(Schema.Int).pipe(Schema.optional),
  latestVersion: Schema.Struct({ status: Schema.String }).pipe(Schema.optional),
  status: Schema.String.pipe(Schema.optional),
  courseTitle: Schema.NullOr(Schema.String).pipe(Schema.optional),
})
export const ReferencePlan = Schema.Struct({
  title: Schema.String,
  courseId: Schema.Int,
  version: Schema.Int,
  plan: Schema.Struct({
    summary: Schema.String,
    agents: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        brief: Schema.String,
        models: Schema.Json.pipe(Schema.optional),
        guardrails: Schema.Json.pipe(Schema.optional),
        includeAssignments: Schema.Boolean.pipe(Schema.optional),
        contextMaterials: Schema.Json.pipe(Schema.optional),
        reasons: Schema.Array(Schema.Json).pipe(Schema.optional),
        skills: Schema.Array(Schema.Json).pipe(Schema.optional),
      }),
    ),
    assignments: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        title: Schema.String,
        description: Schema.String,
        worksheet: Schema.String,
        tasks: Schema.Array(Schema.Json),
        opens: Schema.NullOr(Schema.Json).pipe(Schema.optional),
        due: Schema.NullOr(Schema.Json).pipe(Schema.optional),
        grading: Schema.Json.pipe(Schema.optional),
      }),
    ),
    materials: Schema.Array(Schema.Json),
    notes: Schema.Array(Schema.Json).pipe(Schema.optional),
  }),
  sources: Schema.Array(
    Schema.Struct({ kind: Schema.String, id: Schema.Union([Schema.String, Schema.Number]), title: Schema.String }),
  ),
})

export function referenceFileMime(filename: string) {
  const extension = filename.split(".").at(-1)?.toLowerCase()
  const types: Record<string, string> = {
    pdf: "application/pdf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    xls: "application/vnd.ms-excel",
    csv: "text/csv",
    md: "text/markdown",
    txt: "text/plain",
    json: "application/json",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    svg: "image/svg+xml",
    html: "text/html",
    htm: "text/html",
  }
  return types[extension ?? ""] ?? "application/octet-stream"
}

/** The web reader caps bytes before parsing, including when storage ignores Range. */
export async function readReferenceBytes(url: string, limit: number, signal: AbortSignal) {
  const address = safeReferenceUrl(url)
  if (!address) throw new Error("Invalid reference content URL")
  const response = await fetch(address, { signal, headers: { Range: `bytes=0-${limit}` }, credentials: "omit" })
  if (!response.ok || !response.body) throw new Error("Reference content could not be read")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (length <= limit) {
      const part = await reader.read()
      if (part.done) break
      const chunk = part.value.subarray(0, limit + 1 - length)
      chunks.push(chunk)
      length += chunk.length
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return { bytes: bytes.subarray(0, limit), truncated: length > limit }
}
