import { Effect } from "effect"
import type { Jolli } from "@opencode-ai/schema/jolli"
import { JolliApiError, scopedRequest, type GatewayRequest } from "./api"
import { chatRequest, fetchGroupResource, openChat } from "./group-chat"
import { parseOrgScopedId } from "./org-scoped-id"

/**
 * Read through the same authorized routes as the web chat reference viewers.
 *
 * A group reference opens its chat on every read, though it needs only the chat's course: that open
 * read is the access recheck, so a reader removed from the chat stops reading its references at once.
 * The home org and viewer the open also asks for come from memory after the chat's first open.
 */
export async function readJolliReference(request: GatewayRequest, input: Jolli.ReferenceRequest): Promise<unknown> {
  const chat =
    input.target.kind === "group" ? await Effect.runPromise(openChat(request, input.target.chatID)) : undefined
  const course = parseOrgScopedId(chat?.courseId ?? (input.target.kind === "course" ? input.target.courseId : ""))
  if (input.target.kind === "course" && !course)
    throw new JolliApiError({ path: "reference", status: 400, message: "Invalid reference course" })
  const target =
    input.target.kind === "group"
      ? chatRequest(request, input.target.chatID)
      : { request: scopedRequest(request, course?.org), path: "" }
  const reference = input.reference
  const invalid = () => new JolliApiError({ path: "reference", status: 400, message: "Invalid reference operation" })
  const read = async (path: string, method = "GET", body?: object) =>
    (await fetchGroupResource(target.request, path, method, body)).json()
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
    if (!chat) throw invalid()
    if (!Number.isSafeInteger(reference.attachmentId) || reference.attachmentId <= 0) throw invalid()
    if (input.operation === "read") {
      const attachment = chat.messages
        .flatMap((message) => {
          const payload = message.payload
          return payload &&
            typeof payload === "object" &&
            !Array.isArray(payload) &&
            "attachments" in payload &&
            Array.isArray(payload.attachments)
            ? payload.attachments
            : []
        })
        .find(
          (value) =>
            value &&
            typeof value === "object" &&
            !Array.isArray(value) &&
            "attachmentId" in value &&
            value.attachmentId === reference.attachmentId,
        )
      if (!attachment) throw new JolliApiError({ path: "reference", status: 404, message: "Chat attachment not found" })
      return attachment
    }
    if (input.operation === "content")
      return read(`${target.path}/attachment-urls`, "POST", { attachmentIds: [reference.attachmentId] })
    if (input.operation === "page")
      return read(`${target.path}/attachment-page-urls`, "POST", { attachmentIds: [reference.attachmentId] })
    throw invalid()
  }
  if (!course) throw invalid()
  if (reference.kind === "assignmentFile" || reference.kind === "assignmentDoc") {
    if (
      reference.courseId !== course.id ||
      !Number.isSafeInteger(reference.assignmentId) ||
      reference.assignmentId <= 0 ||
      !Number.isSafeInteger(reference.taskId) ||
      reference.taskId <= 0
    )
      throw invalid()
    const path = `/api/courses/${course.id}/assignments/${reference.assignmentId}/parts/${reference.taskId}`
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
    if (
      reference.courseId !== course.id ||
      !Number.isSafeInteger(reference.assignmentId) ||
      reference.assignmentId <= 0
    )
      throw invalid()
    if (input.operation !== "read") throw invalid()
    return read(
      `/api/courses/${course.id}/assignments/${reference.assignmentId}/${reference.staffView ? "preview" : "student-view"}`,
    )
  }
  if (!Number.isSafeInteger(reference.materialId) || reference.materialId <= 0) throw invalid()
  if (input.operation === "plan") throw invalid()
  const suffix = { read: "view", content: "content", page: "page-url", map: "map" }[input.operation]
  if (!suffix) throw invalid()
  return read(`/api/courses/${course.id}/materials/${reference.materialId}/${suffix}`)
}
