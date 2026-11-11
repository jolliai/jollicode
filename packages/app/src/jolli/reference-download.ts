import { executableChatFile, safeChatFilename } from "@opencode-ai/core/jolli/group-chat-rules"
import { safeReferenceUrl } from "./reference-preview"

export function referenceDownloadFilename(input: {
  disposition?: string | null
  url: string
  filename: string
  mimeType?: string | null
}) {
  const provided =
    filenameOf(input.disposition) ?? filenameOf(new URL(input.url).searchParams.get("response-content-disposition"))
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

/**
 * Fetch the file into the client so download never navigates to its remote address. Resolves whether
 * it was saved.
 *
 * Follows the chat attachment download's rules, because a preview can hold a classmate's file: the
 * name is made safe to save, and a file that could run — by the name it is saved under, the name it
 * was shared as, or either type — is saved only after `allowExecutable` has warned the person and
 * they went ahead. It is never opened.
 */
export async function downloadReferenceFile(
  url: string,
  filename: string,
  mimeType: string | null | undefined,
  allowExecutable: () => Promise<boolean>,
) {
  const address = safeReferenceUrl(url)
  if (!address) throw new Error("Invalid reference download URL")
  const response = await fetch(address, { credentials: "omit" })
  if (!response.ok) throw new Error(`Reference download failed: ${response.status}`)
  const type = response.headers.get("content-type")
  const name = referenceDownloadFilename({
    disposition: response.headers.get("content-disposition"),
    url: address,
    filename,
    mimeType: type && !/^application\/octet-stream\b/i.test(type) ? type : mimeType,
  })
  const blob = await response.blob()
  if (
    (executableChatFile(name, type ?? "") || executableChatFile(filename, mimeType ?? "")) &&
    !(await allowExecutable())
  )
    return false
  const objectUrl = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = objectUrl
  link.download = name
  document.body.appendChild(link)
  try {
    link.click()
  } finally {
    link.remove()
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000)
  }
  return true
}

function filenameOf(disposition: string | null | undefined) {
  if (!disposition) return undefined
  const extended = /(?:^|;)\s*filename\*\s*=\s*"?utf-8'[^']*'([^";]*)/i.exec(disposition)?.[1]
  if (extended) {
    try {
      return decodeURIComponent(extended.trim())
    } catch {
      // A broken extended name can still carry a usable ordinary filename.
    }
  }
  const plain = /(?:^|;)\s*filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/i.exec(disposition)
  return (plain?.[1]?.replace(/\\(.)/g, "$1") ?? plain?.[2])?.trim() || undefined
}
