import { safeChatFilename } from "./group-chat-rules"
import { Effect, Option, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Jolli } from "@opencode-ai/schema/jolli"
import { fetchAssistantChoices, fetchModelIndex, JolliApiError, scopedRequest, type GatewayRequest } from "./api"
import { chatRequest, fetchGroupResource, groupJson, groupViewer, readChatOpen, requestHeaders } from "./group-chat"
import { parseOrgScopedId } from "./org-scoped-id"

/** Node requires duplex for streamed request bodies; Bun accepts the same option. */
function streamed(init: RequestInit): RequestInit {
  return Object.assign(init, { duplex: "half" })
}

async function json(
  request: GatewayRequest,
  path: string,
  method = "GET",
  body?: object,
  signal?: AbortSignal,
): Promise<unknown> {
  return groupJson(await fetchGroupResource(request, path, method, body, signal), path)
}

export async function chatMaterials(request: GatewayRequest, courseId: string) {
  const course = parseOrgScopedId(courseId)
  if (!course) throw new JolliApiError({ path: "materials", status: 400, message: "Invalid course ID" })
  return json(scopedRequest(request, course.org), `/api/courses/${course.id}/readings?includeFolders=true`)
}

export async function chatFeatures(request: GatewayRequest, id: Jolli.GroupChatID) {
  const target = chatRequest(request, id)
  const [config, composer] = await Promise.all([
    json(target.request, "/api/auth/session-config").then(
      Schema.decodeUnknownSync(
        Schema.Struct({
          voice: Schema.Struct({ input: Schema.Boolean, readAloud: Schema.Boolean }).pipe(Schema.optional),
        }),
      ),
    ),
    composerChoices(request, id),
  ])
  return {
    input: config.voice?.input === true,
    readAloud: config.voice?.readAloud === true,
    ...(composer ? { composer } : {}),
  } satisfies Jolli.GroupChatFeatures
}

/**
 * The models each mentionable agent may answer with. A reader has no composer. A list that cannot be
 * read leaves it empty and marks the composer `unavailable`, which never blocks asking: the ask goes
 * without a model and the server uses the agent's default.
 */
async function composerChoices(request: GatewayRequest, id: Jolli.GroupChatID) {
  const opened = await readChatOpen(request, id).catch(() => undefined)
  if (opened?.access === "reader") return undefined
  const target = chatRequest(request, id)
  const spaceId = opened?.detail.spaceId
  const [models, assistants] = await Promise.all([
    Effect.runPromise(fetchModelIndex(target.request).pipe(Effect.provide(FetchHttpClient.layer))).catch(
      () => undefined,
    ),
    spaceId === undefined || spaceId === null
      ? undefined
      : Effect.runPromise(
          fetchAssistantChoices(target.request, spaceId).pipe(Effect.provide(FetchHttpClient.layer)),
        ).catch(() => undefined),
  ])
  return {
    models: models ? Array.from(models.values(), (model) => ({ id: model.id, name: model.name })) : [],
    assistants: (assistants ?? [])
      .filter((assistant) => opened?.detail.group.mentionable?.some((agent) => agent.id === assistant.id))
      .map((assistant) => ({
        id: assistant.id,
        modelId: assistant.modelId,
        allowedModelIds: assistant.allowedModelIds,
      })),
    ...(models && assistants ? {} : { unavailable: true }),
  }
}

export async function chatShares(request: GatewayRequest, id: Jolli.GroupChatID, subject?: string | null) {
  const opened = await readChatOpen(request, id)
  if (opened.access === "reader" || opened.detail.group.assignmentGroupId !== undefined)
    throw new JolliApiError({ path: "shares", status: 403, code: "not_allowed", message: "This chat cannot be shared" })
  const spaceId = opened.detail.spaceId
  if (spaceId === undefined || spaceId === null)
    throw new JolliApiError({ path: "shares", status: 404, message: "Course not found" })
  const viewerId = await groupViewer(request, subject)
  const staff = opened.detail.group.participants.some((person) => person.userId === viewerId && person.role === "staff")
  const [visibility, members, board] = await Promise.all([
    json(opened.target.request, `${opened.target.path}/shares`),
    json(opened.target.request, `/api/spaces/${spaceId}/members`),
    staff ? json(opened.target.request, `/api/courses/${spaceId}/groups`) : Promise.resolve({ groups: [] }),
  ])
  return { visibility, members, board, role: staff ? "staff" : "student" }
}

export async function changeChatShare(
  request: GatewayRequest,
  id: Jolli.GroupChatID,
  subject: number | "everyone" | { groupId: number },
  remove: boolean,
) {
  const target = chatRequest(request, id)
  if (remove) {
    const path = typeof subject === "object" ? `/shares/groups/${subject.groupId}` : `/shares/${subject}`
    return json(target.request, target.path + path, "DELETE")
  }
  return json(target.request, `${target.path}/shares`, "POST", {
    ...(typeof subject === "object" ? { subjectGroupId: subject.groupId } : { subjectUserId: subject }),
    access: "view",
  })
}

export async function attachmentUrls(request: GatewayRequest, id: Jolli.GroupChatID, attachmentIds: readonly number[]) {
  const target = chatRequest(request, id)
  return json(target.request, `${target.path}/attachment-urls`, "POST", { attachmentIds })
}

export async function chatAttachmentStatus(request: GatewayRequest, id: Jolli.GroupChatID, attachmentId: number) {
  const target = chatRequest(request, id)
  return json(target.request, `/api/attachments/${attachmentId}`)
}

/**
 * Transfer bytes to the upload ticket's signed target, never to a caller-selected destination.
 *
 * `authorized` runs each gateway call, renewing the credential on a refusal. It wraps the calls one
 * by one rather than the whole upload: the incoming body can be read only once, so a refusal after
 * the bytes went out (a token that expired during a long upload) must retry the registration alone.
 */
export async function uploadChatAttachment(
  authorized: <A>(run: (request: GatewayRequest) => Promise<A>) => Promise<A>,
  id: Jolli.GroupChatID,
  incoming: Request,
) {
  const call = (path: string, body: object) =>
    authorized((request) => json(chatRequest(request, id).request, path, "POST", body))
  const filename = safeChatFilename(headerFilename(incoming.headers.get("x-filename") ?? "attachment"))
  const sizeBytes = Number(incoming.headers.get("x-file-size"))
  const contentType = incoming.headers.get("content-type") ?? "application/octet-stream"
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || !incoming.body)
    throw new JolliApiError({ path: "attachment", status: 400, message: "A file and its size are required" })
  const ticket = Schema.decodeUnknownSync(
    Schema.Union([
      Schema.Struct({
        kind: Schema.Literal("upload"),
        ticket: Schema.Struct({
          url: Schema.String,
          objectKey: Schema.String,
          requiredHeaders: Schema.Record(Schema.String, Schema.String),
          attachmentId: Schema.Int,
        }),
      }),
      Schema.Struct({ kind: Schema.Literal("reused"), attachment: Schema.Json }),
    ]),
  )(await call("/api/attachments/upload-ticket", { filename, sizeBytes, contentType }))
  if (ticket.kind === "reused") {
    await incoming.body.cancel()
    return ticket.attachment
  }
  const url = new URL(ticket.ticket.url)
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1")
    throw new Error("Invalid attachment upload target")
  // The ticket signs the declared length, and storage refuses a chunked upload: the body is sent with
  // that length and stopped as soon as it proves to be any other.
  let received = 0
  let mismatch = false
  const body = incoming.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength
        mismatch = received > sizeBytes
        if (mismatch) {
          controller.error(sizeMismatch())
          return
        }
        controller.enqueue(chunk)
      },
      flush(controller) {
        mismatch = received !== sizeBytes
        if (mismatch) controller.error(sizeMismatch())
      },
    }),
  )
  const uploaded = await fetch(
    url,
    streamed({
      method: "PUT",
      headers: { ...ticket.ticket.requiredHeaders, "Content-Length": String(sizeBytes) },
      body,
      signal: incoming.signal,
      redirect: "error",
    }),
  ).catch((cause) => {
    throw mismatch ? sizeMismatch() : cause
  })
  await uploaded.body?.cancel()
  if (!uploaded.ok) throw new Error("Attachment upload failed")
  const attachment = await call(`/api/attachments/${ticket.ticket.attachmentId}/register`, {
    objectKey: ticket.ticket.objectKey,
  })
  const facts = Schema.decodeUnknownSync(
    Schema.Struct({ index: Schema.Struct({ status: Schema.String }).pipe(Schema.optional) }),
  )(attachment)
  if (facts.index?.status === "queued") {
    await call(`/api/attachments/${ticket.ticket.attachmentId}/prepare`, {}).catch(() => undefined)
  }
  return attachment
}

function sizeMismatch() {
  return new JolliApiError({
    path: "attachment",
    status: 400,
    code: "size_mismatch",
    message: "The file is not the size it was declared to be",
  })
}

/** A percent-encoded header that does not decode is used as written; it is sanitized either way. */
function headerFilename(value: string) {
  return Option.getOrElse(Option.liftThrowable(decodeURIComponent)(value), () => value)
}

/** Only the caller's explicit action downloads a peer's file. No file is executed or opened. */
export async function downloadChatAttachment(
  request: GatewayRequest,
  id: Jolli.GroupChatID,
  attachmentId: number,
  filename: string,
  signal?: AbortSignal,
) {
  const batch = Schema.decodeUnknownSync(Schema.Struct({ urls: Schema.Record(Schema.String, Schema.String) }))(
    await attachmentUrls(request, id, [attachmentId]),
  )
  const url = batch.urls[String(attachmentId)]
  if (!url || !URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol))
    throw new Error("Attachment download URL is missing")
  // No size cap or timeout of our own: the backend signs this URL for a file its upload policy already
  // capped (the upload ticket signs the declared length), and `signal` ends the transfer with the
  // caller's request. A failed or cancelled copy removes its temporary directory.
  const response = await fetch(url, { redirect: "error", signal })
  if (!response.ok || !response.body) {
    await response.body?.cancel()
    throw new Error("Attachment download failed")
  }
  const { mkdtemp, open, rm } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const name = safeChatFilename(filename)
  const directory = await mkdtemp(join(tmpdir(), "jolli-group-chat-"))
  const path = join(directory, name)
  const cleanup = () => rm(directory, { recursive: true, force: true })
  const saved = await saveDownload(response.body, path)
    .then(() => open(path, "r"))
    .catch(async (error) => {
      await cleanup()
      throw error
    })
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await saved.close().finally(cleanup)
  }
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = await saved.read(new Uint8Array(64 * 1024)).catch(async (error) => {
        await close()
        controller.error(error)
        return undefined
      })
      if (!chunk) return
      if (!chunk.bytesRead) {
        await close()
        controller.close()
        return
      }
      controller.enqueue(chunk.buffer.subarray(0, chunk.bytesRead))
    },
    cancel: close,
  })
  return new Response(body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  })
}

/** Write a peer's bytes to a new private file; the handle is closed whatever happens. */
async function saveDownload(source: ReadableStream<Uint8Array>, path: string) {
  const { open } = await import("node:fs/promises")
  const file = await open(path, "wx", 0o600)
  const reader = source.getReader()
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) return
      let offset = 0
      while (offset < chunk.value.length) {
        const written = await file.write(chunk.value, offset, chunk.value.length - offset)
        if (!written.bytesWritten) throw new Error("Attachment could not be saved")
        offset += written.bytesWritten
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
    await file.close()
  }
}

export async function voiceRequest(
  request: GatewayRequest,
  id: Jolli.GroupChatID,
  incoming: Request,
  operation: "transcription" | "poll" | "read-aloud" | "release",
  requestId?: string,
) {
  const target = chatRequest(request, id)
  const headers = new Headers(requestHeaders(target.request))
  for (const name of ["x-request-id", "x-voice-session", "x-voice-locale", "content-type"]) {
    const value = incoming.headers.get(name)
    if (value) headers.set(name, value)
  }
  headers.set("x-conversation-id", target.path.split("/").at(-1)!)
  const suffix =
    operation === "transcription"
      ? "/transcriptions"
      : operation === "poll"
        ? `/transcriptions/${encodeURIComponent(requestId ?? "")}`
        : operation === "release"
          ? "/session"
          : "/read-aloud"
  const body =
    operation === "read-aloud"
      ? JSON.stringify({
          ...Schema.decodeUnknownSync(
            Schema.Struct({
              messageId: Schema.Int,
              segment: Schema.Int,
              narrationVersion: Schema.String.pipe(Schema.optional),
            }),
          )(await incoming.json()),
          conversationId: target.path.split("/").at(-1),
        })
      : operation === "transcription"
        ? incoming.body
        : undefined
  const response = await fetch(
    new URL(`/api/voice${suffix}`, request.origin),
    streamed({
      method: operation === "poll" ? "GET" : operation === "release" ? "DELETE" : "POST",
      headers,
      body,
      signal: incoming.signal,
      redirect: "error",
    }),
  )
  const output = new Headers()
  for (const name of ["content-type", "x-voice-narration-version", "x-voice-segment-count", "retry-after"]) {
    const value = response.headers.get(name)
    if (value) output.set(name, value)
  }
  output.set("Access-Control-Expose-Headers", "X-Voice-Narration-Version, X-Voice-Segment-Count, Retry-After")
  output.set("cache-control", "no-store")
  return new Response(response.body, { status: response.status, headers: output })
}
