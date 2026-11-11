import type { Jolli } from "@opencode-ai/schema/jolli"
import { Option, Schema } from "effect"
import { JolliApiError, scopedRequest, type GatewayRequest } from "./api"
import { chatCourse, chatRequest, fetchGroupResource, groupJson } from "./group-chat"
import { parseOrgScopedId } from "./org-scoped-id"

/**
 * Read through the same authorized routes as the web chat reference viewers.
 *
 * A group reference never reads its chat's transcript: an attachment is described by the chat's address
 * route, and a course's reference needs only the chat's course, which is remembered after the chat's
 * first open. Every content route checks access itself: attachment addresses by the chat, course routes
 * by the course.
 */
/** The address route's description of each file; only the fields of each attachment pass through as sent. */
const AttachmentDescriptions = Schema.Struct({
  attachments: Schema.Record(
    Schema.String,
    Schema.Struct({ attachment: Schema.Record(Schema.String, Schema.Json) }),
  ).pipe(Schema.optional),
})

export async function readJolliReference(request: GatewayRequest, input: Jolli.ReferenceRequest): Promise<unknown> {
  const target = input.target
  const course = target.kind === "course" ? parseOrgScopedId(target.courseId) : undefined
  if (target.kind === "course" && !course)
    throw new JolliApiError({ path: "reference", status: 400, message: "Invalid reference course" })
  const chat = target.kind === "group" ? chatRequest(request, target.chatID) : undefined
  const scope = chat?.request ?? scopedRequest(request, course?.org)
  const reference = input.reference
  const invalid = () => new JolliApiError({ path: "reference", status: 400, message: "Invalid reference operation" })
  const read = async (path: string, method = "GET", body?: object) =>
    groupJson(await fetchGroupResource(scope, path, method, body), path)
  if (reference.kind === "artifact") {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(reference.artifactId)) throw invalid()
    if (reference.version !== undefined && (!Number.isSafeInteger(reference.version) || reference.version <= 0))
      throw invalid()
    const path = `/api/studio-artifacts/${encodeURIComponent(reference.artifactId)}`
    if (input.operation === "read") return read(path)
    if (input.operation === "page")
      return read(`${path}/view-url`, "POST", reference.version === undefined ? {} : { version: reference.version })
    if (input.operation === "plan")
      return read(`${path}/plan${reference.version === undefined ? "" : `?version=${reference.version}`}`)
    throw invalid()
  }
  if (reference.kind === "attachment") {
    if (target.kind !== "group" || !chat) throw invalid()
    if (!Number.isSafeInteger(reference.attachmentId) || reference.attachmentId <= 0) throw invalid()
    if (input.operation === "read") {
      // The address route also describes each file as it stands now, which is what the reader needs (its
      // type, and whether it is still being processed), without reading the chat's whole transcript.
      const described = Option.getOrUndefined(
        Schema.decodeUnknownOption(AttachmentDescriptions)(
          await read(`${chat.path}/attachment-urls`, "POST", { attachmentIds: [reference.attachmentId] }),
        ),
      )?.attachments?.[String(reference.attachmentId)]?.attachment
      if (!described) throw new JolliApiError({ path: "reference", status: 404, message: "Chat attachment not found" })
      return { ...described, attachmentId: reference.attachmentId }
    }
    if (input.operation === "content")
      return read(`${chat.path}/attachment-urls`, "POST", { attachmentIds: [reference.attachmentId] })
    if (input.operation === "page")
      // One file per request, named in the singular: unlike `attachment-urls`, this route reads `attachmentId`.
      return read(`${chat.path}/attachment-page-urls`, "POST", { attachmentId: reference.attachmentId })
    throw invalid()
  }
  const courseId = target.kind === "group" ? await chatCourse(request, target.chatID) : course?.id
  if (courseId === undefined) throw invalid()
  if (reference.kind === "assignmentFile" || reference.kind === "assignmentDoc") {
    if (
      reference.courseId !== courseId ||
      !Number.isSafeInteger(reference.assignmentId) ||
      reference.assignmentId <= 0 ||
      !Number.isSafeInteger(reference.taskId) ||
      reference.taskId <= 0
    )
      throw invalid()
    const path = `/api/courses/${courseId}/assignments/${reference.assignmentId}/parts/${reference.taskId}`
    if (reference.kind === "assignmentFile") {
      if (!Number.isSafeInteger(reference.fileId) || reference.fileId <= 0) throw invalid()
      if (input.operation === "read" || input.operation === "content")
        return read(`${path}/files/${reference.fileId}/download`)
      if (input.operation === "page") return read(`${path}/files/${reference.fileId}/page-url`)
      throw invalid()
    }
    if (
      !Number.isSafeInteger(reference.docId) ||
      reference.docId < (reference.submitted ? 0 : 1) ||
      input.operation !== "read"
    )
      throw invalid()
    return read(`${path}/${reference.submitted ? "handed-in-docs" : "docs"}/${reference.docId}`)
  }
  if (reference.kind === "assignment") {
    if (reference.courseId !== courseId || !Number.isSafeInteger(reference.assignmentId) || reference.assignmentId <= 0)
      throw invalid()
    if (input.operation !== "read") throw invalid()
    return read(
      `/api/courses/${courseId}/assignments/${reference.assignmentId}/${reference.staffView ? "preview" : "student-view"}`,
    )
  }
  if (!Number.isSafeInteger(reference.materialId) || reference.materialId <= 0) throw invalid()
  if (input.operation === "plan") throw invalid()
  const suffix = { read: "view", content: "content", page: "page-url", map: "map" }[input.operation]
  if (!suffix) throw invalid()
  return read(`/api/courses/${courseId}/materials/${reference.materialId}/${suffix}`)
}
