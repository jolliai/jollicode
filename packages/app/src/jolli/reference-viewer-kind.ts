/**
 * Which viewer draws a course material — decided here, from its MIME type, and nowhere else.
 *
 * The server's view descriptor, the student's reading card and the reader itself all ask
 * this question. If any of them answered it on its own, a card could offer "Open" for a
 * file the reader then refuses to draw.
 */

export type CourseMaterialViewerKind =
  | "pdf"
  | "docx"
  | "excel"
  | "image"
  | "markdown"
  | "csv"
  | "text"
  | "mindmap"
  | "webpage"
  | "none"
const XLS_MEDIA_TYPE = "application/vnd.ms-excel"
const XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

/**
 * The types that have a viewer of their own. Anything under `text/` that is not listed
 * falls through to the plain text viewer; anything else is `none`.
 *
 * ⚠ Download-only by decision, not by omission: `.pptx`, `.doc`, `.ppt`, `.rtf` and
 * HEIC/HEIF. No renderer small enough to ship draws them faithfully, and a slide that looks
 * whole while missing its equation is worse than a download. They are absent from this
 * table so they reach `none`; `text/rtf` is listed only to keep RTF source out of the text
 * viewer when a deployment configures RTF under that name.
 */
const VIEWER_KINDS: ReadonlyMap<string, CourseMaterialViewerKind> = new Map([
  ["application/pdf", "pdf"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"],
  [XLSX_MEDIA_TYPE, "excel"],
  [XLS_MEDIA_TYPE, "excel"],
  ["image/png", "image"],
  ["image/jpeg", "image"],
  ["image/webp", "image"],
  // Safe only because the reader draws an SVG through `<img>` from the signed URL, where
  // its scripts never run.
  ["image/svg+xml", "image"],
  ["text/markdown", "markdown"],
  ["text/csv", "csv"],
  ["text/rtf", "none"],
  // HTML is never decided by its type: a MindManager export is a viewer app and a base64 archive, drawn from its
  // parsed tree (`map`), and a web page is shown as a page only when the server says so (`webPage`). HTML alone is
  // downloaded.
  ["text/html", "none"],
])

/**
 * The viewer for a material whose stored MIME type is `mimeType`.
 *
 * Null — a type nobody has verified yet — is `none`. Parameters and case are ignored, since
 * a deployment may configure an extension's type as `Text/CSV; charset=utf-8`.
 *
 * `map` says the material is a MindManager map — the server's word, carried on the material — which is drawn as
 * a mind map whatever its type: an `.mmap` and an `.html` export alike. `webPage` says the server offers it as a
 * web page, which is shown as the page in a sandbox on a host of its own.
 */
export function materialViewerKind(
  mimeType: string | null,
  options?: { readonly map?: boolean | undefined; readonly webPage?: boolean | undefined },
): CourseMaterialViewerKind {
  if (options?.map === true) {
    return "mindmap"
  }
  if (options?.webPage === true) {
    return "webpage"
  }
  if (mimeType === null) {
    return "none"
  }
  const essence = mimeType.split(";")[0].trim().toLowerCase()
  const kind = VIEWER_KINDS.get(essence)
  if (kind !== undefined) {
    return kind
  }
  return essence.startsWith("text/") ? "text" : "none"
}
