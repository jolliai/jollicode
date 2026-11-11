import { Option } from "effect"
import { executableChatFile, safeChatFilename } from "@opencode-ai/core/jolli/group-chat-rules"
import { safeReferenceUrl } from "./external-link"

export function referenceDownloadFilename(input: {
  disposition?: string | null
  url?: string
  filename: string
  mimeType?: string | null
}) {
  const provided =
    filenameOf(input.disposition) ??
    filenameOf(
      input.url && URL.canParse(input.url)
        ? new URL(input.url).searchParams.get("response-content-disposition")
        : undefined,
    )
  if (provided) return safeChatFilename(provided)
  const name = safeChatFilename(input.filename || "download")
  if (/\.[a-z0-9]{1,10}$/i.test(name)) return name
  const type = input.mimeType?.split(";")[0].trim().toLowerCase()
  const extension =
    type &&
    (
      {
        "application/pdf": "pdf",
        "application/msword": "doc",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
        "application/vnd.ms-excel": "xls",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
        "application/vnd.ms-powerpoint": "ppt",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
        "text/plain": "txt",
        "text/markdown": "md",
        "text/csv": "csv",
        "text/html": "html",
        "application/json": "json",
        "application/zip": "zip",
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/webp": "webp",
        "image/svg+xml": "svg",
      } as Record<string, string>
    )[type]
  return extension ? `${name}.${extension}` : name
}

/** A file that did not arrive; `status` is the server's answer when there was one. */
export class ChatFileDownloadError extends Error {
  constructor(readonly status?: number) {
    super(status === undefined ? "Chat file download failed" : `Chat file download failed: ${status}`)
  }
}

/**
 * Saves a file from a chat message or a reference preview without navigating to it, and never opens it.
 * Resolves whether it was saved: not when the person declined a file that could run, nor once `signal`
 * has ended the transfer, after which nothing is asked or saved. Every failure rejects with a
 * {@link ChatFileDownloadError}, which carries the server's status when it answered.
 *
 * `source` is an `http(s)` address, read without credentials, or the request that reads the file, which
 * is handed `signal`.
 *
 * A message or a preview can carry a classmate's file, so the name is made safe to save, and a file
 * that could run, by the name it is saved under, the name it was shared as, or either type, is saved
 * only after `allowExecutable` has warned the person and they went ahead. They are asked once, after the
 * bytes have arrived: a source left waiting on the person would stall and end the transfer.
 *
 * The bytes are read whole into a blob rather than streamed to disk. A chat attachment is capped by the
 * server's settings, by default 5 MB, or 100 MB where a retrieval engine indexes attachments, and a
 * setting of 0 lifts the cap; the preview also saves course materials and assignment files, which have
 * caps of their own. Chromium holds a blob's bytes in its browser process, up to a quota, and moves
 * them to disk past it, so a large file does not sit in the renderer's JavaScript heap.
 */
export async function downloadChatFile(input: {
  source: string | ((signal?: AbortSignal) => Promise<Response>)
  filename: string
  mimeType?: string | null
  allowExecutable: () => Promise<boolean>
  signal?: AbortSignal
}) {
  const signal = input.signal
  const response = await requestFile(input.source, signal).catch(() => undefined)
  if (signal?.aborted) {
    await response?.body?.cancel().catch(() => undefined)
    return false
  }
  if (!response?.ok) {
    await response?.body?.cancel().catch(() => undefined)
    throw new ChatFileDownloadError(response?.status)
  }
  const type = response.headers.get("content-type")
  const name = referenceDownloadFilename({
    disposition: response.headers.get("content-disposition"),
    url: typeof input.source === "string" ? input.source : response.url,
    filename: input.filename,
    mimeType: type && !/^application\/octet-stream\b/i.test(type) ? type : input.mimeType,
  })
  const blob = await response.blob().catch(() => undefined)
  if (signal?.aborted) return false
  if (!blob) throw new ChatFileDownloadError()
  if (
    (executableChatFile(name, type ?? "") || executableChatFile(input.filename, input.mimeType ?? "")) &&
    !(await input.allowExecutable())
  )
    return false
  // The person may have taken a while to go ahead, and the page or the account may have gone meanwhile.
  if (signal?.aborted) return false
  const objectUrl = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = objectUrl
  link.download = name
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000)
  return true
}

async function requestFile(source: string | ((signal?: AbortSignal) => Promise<Response>), signal?: AbortSignal) {
  if (typeof source !== "string") return source(signal)
  const address = safeReferenceUrl(source)
  if (!address) throw new Error("Invalid file address")
  return fetch(address, { credentials: "omit", signal })
}

function filenameOf(disposition: string | null | undefined) {
  if (!disposition) return undefined
  const extended = /(?:^|;)\s*filename\*\s*=\s*"?utf-8'[^']*'([^";]*)/i.exec(disposition)?.[1]
  // A broken extended name can still carry a usable ordinary filename.
  const decoded = extended && Option.getOrUndefined(Option.liftThrowable(decodeURIComponent)(extended.trim()))
  if (decoded) return decoded
  const plain = /(?:^|;)\s*filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/i.exec(disposition)
  return (plain?.[1]?.replace(/\\(.)/g, "$1") ?? plain?.[2])?.trim() || undefined
}
