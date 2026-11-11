import { Option, Schema } from "effect"
import { createStore } from "solid-js/store"
import { onCleanup } from "solid-js"
import type { Jolli } from "@opencode-ai/schema/jolli"
import type { ServerSDK } from "@/context/server-sdk"
import { authTokenFromCredentials } from "@/utils/server"
import { safeChatFilename } from "@opencode-ai/core/jolli/group-chat-rules"
import { decodeChatAnswer } from "./group-chat"

export const ChatAttachment = Schema.Struct({
  id: Schema.Int,
  filename: Schema.String,
  mimeType: Schema.String,
  state: Schema.String,
  textState: Schema.NullOr(Schema.String).pipe(Schema.optional),
  index: Schema.Struct({ status: Schema.String, progress: Schema.Number.pipe(Schema.optional) }).pipe(Schema.optional),
})
export type ChatAttachment = typeof ChatAttachment.Type
export type AttachmentChip = {
  key: string
  name: string
  attachment?: ChatAttachment
  progress: number
  failed: boolean
}
export const ChatMaterial = Schema.Struct({
  id: Schema.Int,
  title: Schema.String,
  textState: Schema.NullOr(Schema.String).pipe(Schema.optional),
  textSource: Schema.NullOr(Schema.String).pipe(Schema.optional),
  textReplaced: Schema.Boolean.pipe(Schema.optional),
})
export type ChatMaterial = typeof ChatMaterial.Type
export const MaterialList = Schema.Union([
  Schema.Array(ChatMaterial),
  Schema.Struct({ readings: Schema.Array(ChatMaterial) }),
  Schema.Struct({ materials: Schema.Array(ChatMaterial) }),
])

/** How long a file the server is still processing is waited for before it reads as failed. */
const FOLLOW_LIMIT_MS = 10 * 60_000

/**
 * This authenticates to the local sidecar only. Jolli credentials never reach this process.
 *
 * The route is joined below the server's address, as the generated SDK joins its own, so a server
 * reached under a path prefix keeps it.
 */
export function groupChatFetch(sdk: ServerSDK, path: string, init: RequestInit = {}) {
  if (!path.startsWith("/jolli/")) throw new Error("Invalid group chat route")
  const headers = new Headers(init.headers)
  if (sdk.server.http.password)
    headers.set(
      "Authorization",
      `Basic ${authTokenFromCredentials({ username: sdk.server.http.username, password: sdk.server.http.password })}`,
    )
  return fetch(new URL(path.slice(1), sdk.url.endsWith("/") ? sdk.url : `${sdk.url}/`), { ...init, headers })
}

export type GroupChatAttachmentDraft = { files: AttachmentChip[]; materials: ChatMaterial[]; error: boolean }

/**
 * The files and course materials the composer carries for one chat. `signOut` hears a status read that
 * answered the credential is gone: the window then drops the server's chats, these chips with them.
 */
export function useGroupChatAttachments(
  sdk: () => ServerSDK,
  id: () => Jolli.GroupChatID,
  stored?: ReturnType<typeof createStore<GroupChatAttachmentDraft>>,
  signOut?: () => void,
) {
  const [state, setState] = stored ?? createStore<GroupChatAttachmentDraft>({ files: [], materials: [], error: false })
  let abort = new AbortController()
  const update = (key: string, patch: Partial<AttachmentChip>) => setState("files", (chip) => chip.key === key, patch)
  /**
   * The attachment as the server describes it now, or `undefined` when the server said the file is gone:
   * access to the chat is gone, or the attachment route itself answered 404 or 410 with its JSON error
   * (jolliedu's "No such attachment", which the sidecar passes on as the refusal's `message` without a
   * code), or it described the file in a way this cannot read. Everything else is `"retry"` and says
   * nothing about the file: no answer, a lost sign-in (which also goes to `signOut`), a timeout or rate
   * limit, and a refusal of the request rather than the file, such as an org it could not be placed in
   * (`tenant_resolution_failed`), the school asking for a fresh sign-in, or a 404 a proxy answered with a
   * page of its own.
   */
  const status = (attachmentId: number, signal: AbortSignal) =>
    sdk()
      .client.jolli.groupChatAttachmentStatus({ chatID: id(), attachmentId: String(attachmentId) }, { signal })
      .then((response) => {
        const answer = decodeChatAnswer(response.data)
        if (answer.status === "ok")
          return Option.getOrUndefined(Schema.decodeUnknownOption(ChatAttachment)(answer.resource))
        if (answer.status === "revoked") return undefined
        if (answer.status === "signed-out") signOut?.()
        const gone =
          answer.status === "refused" &&
          (answer.httpStatus === 404 || answer.httpStatus === 410) &&
          answer.code === undefined &&
          answer.message !== undefined
        return gone ? undefined : ("retry" as const)
      })
      .catch(() => "retry" as const)
  /**
   * Follows the server's processing of bytes that already arrived until the file is usable or gone, the
   * chip is removed, or {@link FOLLOW_LIMIT_MS} passes: a file still processing then reads as failed, so it
   * can be removed and the message sent without it rather than waiting with no end. A read that says
   * nothing about the file keeps the last known state and asks again.
   */
  const follow = async (key: string, first: ChatAttachment) => {
    const signal = abort.signal
    const deadline = Date.now() + FOLLOW_LIMIT_MS
    let attachment: ChatAttachment | undefined = first
    while (
      attachment &&
      (attachment.state === "pending" ||
        attachment.index?.status === "queued" ||
        attachment.index?.status === "processing") &&
      !signal.aborted &&
      Date.now() < deadline &&
      state.files.some((chip) => chip.key === key)
    ) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1500)
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer)
            resolve()
          },
          { once: true },
        )
      })
      if (signal.aborted) return
      const next = await status(first.id, signal)
      if (next === "retry") continue
      attachment = next
      if (attachment) update(key, { attachment })
    }
    if (signal.aborted) return
    update(key, {
      progress: 100,
      ...(attachment ? { attachment } : {}),
      failed: !attachment || attachment.state !== "available" || attachment.index?.status === "failed",
    })
  }
  /** Chips whose bytes have started on their way, as opposed to ones still waiting for their turn. */
  const started = new Set<string>()
  onCleanup(() => {
    abort.abort()
    // Only bytes still on their way are lost with the page; uploaded files keep processing on the server.
    // A file still waiting for its turn never left, so it is dropped as if it had not been chosen.
    setState("files", (files) =>
      files.flatMap((chip) =>
        chip.attachment || chip.failed ? [chip] : started.has(chip.key) ? [{ ...chip, failed: true }] : [],
      ),
    )
  })
  // Uploads whose bytes arrived before the reader last left this chat are followed again.
  for (const chip of state.files)
    if (chip.attachment && chip.progress < 100 && !chip.failed) void follow(chip.key, chip.attachment)
  /** Sends one file's bytes and follows the server's processing of it; failures stay on its chip. */
  const upload = async (file: File, key: string) => {
    const signal = abort.signal
    started.add(key)
    const response = await groupChatFetch(sdk(), `/jolli/group-chat/${encodeURIComponent(id())}/attachment`, {
      method: "POST",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "X-Filename": encodeURIComponent(safeChatFilename(file.name).toWellFormed()),
        "X-File-Size": String(file.size),
      },
      body: file,
      signal,
    }).catch(() => undefined)
    const attachment =
      response?.ok === true
        ? Option.getOrUndefined(
            Schema.decodeUnknownOption(ChatAttachment)(await response.json().catch(() => undefined)),
          )
        : undefined
    if (signal.aborted) return
    if (!attachment) {
      update(key, { failed: true })
      return
    }
    update(key, { progress: 80, attachment })
    void follow(key, attachment)
  }
  const add = async (files: readonly File[]) => {
    // The notice is about the last choice that went over a limit; a new choice starts without it.
    setState("error", false)
    const room = Math.max(0, 10 - state.files.length)
    if (files.length > room) setState("error", true)
    // Every chip is placed before any upload starts, so the limit holds however drops and pastes overlap.
    const chosen = files.slice(0, room).map((file) => ({ file, key: crypto.randomUUID() }))
    setState("files", (items) => [
      ...items,
      ...chosen.map((item) => ({ key: item.key, name: item.file.name, progress: 0, failed: false })),
    ])
    // Two at a time, as the web composer uploads: faster than one after another, gentler than all at once.
    const queue = [...chosen]
    const signal = abort.signal
    const next = async (): Promise<void> => {
      const item = queue.shift()
      if (!item || signal.aborted) return
      await upload(item.file, item.key)
      return next()
    }
    await Promise.all([next(), next()])
  }
  return {
    state,
    add,
    ready: () => state.files.every((chip) => chip.progress === 100 && !chip.failed),
    ids: () => state.files.flatMap((chip) => (chip.attachment ? [chip.attachment.id] : [])),
    materialIds: () => state.materials.map((material) => material.id),
    remove: (key: string) => setState({ files: state.files.filter((chip) => chip.key !== key), error: false }),
    pin(material: ChatMaterial) {
      if (state.materials.some((item) => item.id === material.id)) return
      if (state.materials.length >= 4) {
        setState("error", true)
        return
      }
      setState({ materials: [...state.materials, material], error: false })
    },
    unpin: (id: number) =>
      setState({ materials: state.materials.filter((material) => material.id !== id), error: false }),
    accepted(ids: readonly number[], materials: readonly number[]) {
      setState({
        files: state.files.filter((chip) => !chip.attachment || !ids.includes(chip.attachment.id)),
        materials: state.materials.filter((material) => !materials.includes(material.id)),
        error: false,
      })
    },
    /**
     * After a message was refused for its files, marks every file the server says it no longer offers.
     * A read that says nothing about the file leaves its chip as it is.
     */
    async recheck() {
      const signal = abort.signal
      for (const chip of state.files) {
        if (!chip.attachment || chip.failed) continue
        const attachment = await status(chip.attachment.id, signal)
        if (signal.aborted) return
        if (attachment === "retry") continue
        if (!attachment || attachment.state !== "available" || attachment.index?.status === "failed")
          update(chip.key, { failed: true })
      }
    },
    clear() {
      abort.abort()
      abort = new AbortController()
      setState({ files: [], materials: [], error: false })
    },
  }
}

/**
 * The sidecar's read of one attachment's bytes, for `downloadChatFile`. The sidecar names the file in
 * its response, by the name it was shared as, made safe to save.
 */
export function groupAttachmentFile(
  sdk: ServerSDK,
  id: Jolli.GroupChatID,
  attachmentId: number,
  filename: string,
  signal?: AbortSignal,
) {
  return groupChatFetch(
    sdk,
    `/jolli/group-chat/${encodeURIComponent(id)}/download/${attachmentId}?filename=${encodeURIComponent(safeChatFilename(filename).toWellFormed())}`,
    { signal },
  )
}

/**
 * One change to a chat; a request that got no answer throws. A target without an `assistantId` points
 * the composer back at the whole group.
 */
export async function changeGroupChat(sdk: ServerSDK, chatID: Jolli.GroupChatID, action: Jolli.GroupChatAction) {
  const response = await (action.type === "cancel"
    ? sdk.client.jolli.groupChatCancel({ chatID })
    : action.type === "read"
      ? sdk.client.jolli.groupChatRead({ chatID, seq: action.seq })
      : action.type === "target"
        ? sdk.client.jolli.groupChatTarget({ chatID, assistantId: action.assistantId })
        : action.type === "rename"
          ? sdk.client.jolli.groupChatRename({ chatID, title: action.title })
          : action.type === "add"
            ? sdk.client.jolli.groupChatAddPeople({ chatID, userIds: [...action.userIds] })
            : sdk.client.jolli.groupChatRemovePerson({ chatID, userId: String(action.userId) }))
  return decodeChatAnswer(response.data)
}
