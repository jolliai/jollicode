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

/** This authenticates to the local sidecar only. Jolli credentials never reach this process. */
export function groupChatFetch(sdk: ServerSDK, path: string, init: RequestInit = {}) {
  if (!path.startsWith("/jolli/")) throw new Error("Invalid group chat route")
  const headers = new Headers(init.headers)
  if (sdk.server.http.password)
    headers.set(
      "Authorization",
      `Basic ${authTokenFromCredentials({ username: sdk.server.http.username, password: sdk.server.http.password })}`,
    )
  return fetch(new URL(path, sdk.url), { ...init, headers })
}

export type GroupChatAttachmentDraft = { files: AttachmentChip[]; materials: ChatMaterial[]; error: boolean }

export function useGroupChatAttachments(
  sdk: () => ServerSDK,
  id: () => Jolli.GroupChatID,
  stored?: ReturnType<typeof createStore<GroupChatAttachmentDraft>>,
) {
  const [state, setState] = stored ?? createStore<GroupChatAttachmentDraft>({ files: [], materials: [], error: false })
  let abort = new AbortController()
  const update = (key: string, patch: Partial<AttachmentChip>) => setState("files", (chip) => chip.key === key, patch)
  const status = async (attachmentId: number, signal: AbortSignal) => {
    const answer = decodeChatAnswer(
      (
        await sdk().client.jolli.groupChatAttachmentStatus(
          { chatID: id(), attachmentId: String(attachmentId) },
          { signal },
        )
      ).data,
    )
    if (answer.status !== "ok") return undefined
    return Option.getOrUndefined(Schema.decodeUnknownOption(ChatAttachment)(answer.resource))
  }
  /**
   * Follows the server's processing of bytes that already arrived until the file is usable or refused,
   * the chip is removed, or {@link FOLLOW_LIMIT_MS} passes: a file still processing then reads as
   * failed, so it can be removed and the message sent without it rather than waiting with no end.
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
      attachment = await status(first.id, signal).catch(() => undefined)
      if (attachment) update(key, { attachment })
    }
    if (signal.aborted) return
    update(key, {
      progress: 100,
      ...(attachment ? { attachment } : {}),
      failed: !attachment || attachment.state !== "available" || attachment.index?.status === "failed",
    })
  }
  onCleanup(() => {
    abort.abort()
    // Only bytes still on their way are lost with the page; uploaded files keep processing on the server.
    setState("files", (files) =>
      files.map((chip) => (!chip.attachment && !chip.failed ? { ...chip, failed: true } : chip)),
    )
  })
  // Uploads whose bytes arrived before the reader last left this chat are followed again.
  for (const chip of state.files)
    if (chip.attachment && chip.progress < 100 && !chip.failed) void follow(chip.key, chip.attachment)
  const add = async (files: readonly File[]) => {
    // The notice is about the last choice that went over a limit; a new choice starts without it.
    setState("error", false)
    for (const file of files) {
      // Checked per file, beside the push: a drop and a paste can be uploading at once.
      if (state.files.length >= 10) {
        setState("error", true)
        return
      }
      const key = crypto.randomUUID()
      const signal = abort.signal
      setState("files", (items) => [...items, { key, name: file.name, progress: 0, failed: false }])
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
        continue
      }
      update(key, { progress: 80, attachment })
      void follow(key, attachment)
    }
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
    /** After a message was refused for its files, marks every file the server no longer offers. */
    async recheck() {
      const signal = abort.signal
      for (const chip of state.files) {
        if (!chip.attachment || chip.failed) continue
        const attachment = await status(chip.attachment.id, signal).catch(() => undefined)
        if (signal.aborted) return
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

/** Saves one attachment; answers the sidecar's status so a refusal can be told apart from a lost connection. */
export async function downloadGroupAttachment(
  sdk: ServerSDK,
  id: Jolli.GroupChatID,
  attachmentId: number,
  filename: string,
) {
  const response = await groupChatFetch(
    sdk,
    `/jolli/group-chat/${encodeURIComponent(id)}/download/${attachmentId}?filename=${encodeURIComponent(safeChatFilename(filename).toWellFormed())}`,
  )
  if (!response.ok) {
    await response.body?.cancel()
    return response.status
  }
  const url = URL.createObjectURL(await response.blob())
  const link = document.createElement("a")
  link.href = url
  link.download = safeChatFilename(filename)
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
  return response.status
}

/**
 * Select the declared route while preserving the canonical nullable target contract.
 *
 * Not the generated SDK methods: the generator turns `assistantId: NullOr(Int)` into an optional number,
 * so `groupChatTarget` cannot send the `null` that points the composer back at the whole group. The
 * paths mirror the `groupChat*` endpoints of the `jolli` HttpApi group, and keeping every action here
 * keeps them on one fetch and one answer decoder.
 */
export async function changeGroupChat(sdk: ServerSDK, chatID: Jolli.GroupChatID, action: Jolli.GroupChatAction) {
  const operation =
    action.type === "cancel"
      ? { method: "POST", path: "/cancel", body: undefined }
      : action.type === "read"
        ? { method: "POST", path: "/read", body: { seq: action.seq } }
        : action.type === "target"
          ? { method: "PUT", path: "/composer-target", body: { assistantId: action.assistantId } }
          : action.type === "rename"
            ? { method: "PATCH", path: "", body: { title: action.title } }
            : action.type === "add"
              ? { method: "POST", path: "/participants", body: { userIds: action.userIds } }
              : { method: "DELETE", path: `/participants/${action.userId}`, body: undefined }
  const response = await groupChatFetch(sdk, `/jolli/group-chat/${encodeURIComponent(chatID)}${operation.path}`, {
    method: operation.method,
    ...(operation.body
      ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(operation.body) }
      : {}),
  })
  if (!response.ok) throw new Error("Group chat request failed")
  return decodeChatAnswer(await response.json())
}
