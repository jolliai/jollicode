import { afterEach, describe, expect, test } from "bun:test"
import { createServer, type Server } from "node:http"
import { resolveObjectURL } from "node:buffer"
import { downloadReferenceFile, referenceDownloadFilename } from "./reference-download"

let server: Server | undefined
let stopCapture: (() => void) | undefined
afterEach(async () => {
  stopCapture?.()
  stopCapture = undefined
  const current = server
  server = undefined
  if (current)
    await new Promise<void>((resolve, reject) => current.close((error) => (error ? reject(error) : resolve())))
})

async function startServer(status: number, body: string, headers: Record<string, string> = {}) {
  const current = createServer((request, response) => {
    const cors = {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-expose-headers": "Content-Disposition",
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204, cors)
      response.end()
      return
    }
    response.writeHead(status, { ...cors, ...headers })
    response.end(body)
  })
  server = current
  await new Promise<void>((resolve) => current.listen(0, "127.0.0.1", resolve))
  const address = current.address()
  if (!address || typeof address === "string") throw new Error("Download test server did not bind")
  return `http://127.0.0.1:${address.port}/file`
}

function captureDownloads() {
  const downloads: { url: string; filename: string; target: string }[] = []
  const click = (event: Event) => {
    if (!(event.target instanceof HTMLAnchorElement)) return
    event.preventDefault()
    downloads.push({ url: event.target.href, filename: event.target.download, target: event.target.target })
  }
  document.addEventListener("click", click)
  stopCapture = () => document.removeEventListener("click", click)
  return downloads
}

describe("reference downloads saved by the client", () => {
  test("saves the actual file bytes through a blob download without navigating to the remote URL", async () => {
    const url = await startServer(200, "Course outline", {
      "content-type": "text/markdown",
      "content-disposition": 'attachment; filename="Course outline.md"',
    })
    const downloads = captureDownloads()
    expect(await downloadReferenceFile(url, "Outline", undefined, async () => false)).toBe(true)
    expect(downloads).toHaveLength(1)
    expect(downloads[0].filename).toBe("Course outline.md")
    expect(downloads[0].target).toBe("")
    expect(downloads[0].url.startsWith("blob:")).toBe(true)
    expect(await resolveObjectURL(downloads[0].url)?.text()).toBe("Course outline")
    expect(document.querySelector(`a[href="${downloads[0].url}"]`)).toBeNull()
    URL.revokeObjectURL(downloads[0].url)
  })

  test("prefers the UTF-8 original name and falls back when an extended name is malformed", () => {
    expect(
      referenceDownloadFilename({
        url: "https://storage.example/file",
        filename: "Outline",
        disposition: "attachment; filename=outline.md; filename*=UTF-8''%E8%AF%BE%E7%A8%8B.md",
      }),
    ).toBe("\u8bfe\u7a0b.md")
    expect(
      referenceDownloadFilename({
        url: "https://storage.example/file",
        filename: "Outline",
        disposition: "attachment; filename=outline.md; filename*=UTF-8''%ZZ",
      }),
    ).toBe("outline.md")
  })

  test("reads signed response filename hints and keeps paths out of the saved name", () => {
    const url = new URL("https://storage.example/file")
    url.searchParams.set("response-content-disposition", 'attachment; filename="../Outline.md"')
    expect(referenceDownloadFilename({ url: url.href, filename: "Outline" })).toBe("_Outline.md")
  })

  test("adds a file extension when a material title has none", () => {
    expect(
      referenceDownloadFilename({
        url: "https://storage.example/file",
        filename: "Outline",
        mimeType: "text/markdown; charset=utf-8",
      }),
    ).toBe("Outline.md")
    expect(
      referenceDownloadFilename({
        url: "https://storage.example/file",
        filename: "notes.PDF",
        mimeType: "application/pdf",
      }),
    ).toBe("notes.PDF")
  })

  test("failed and invalid downloads never create a navigation or save link", async () => {
    const url = await startServer(403, "Not available")
    const downloads = captureDownloads()
    const refused = await downloadReferenceFile(url, "Outline", undefined, async () => true).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(refused).toBeInstanceOf(Error)
    const invalid = await downloadReferenceFile("javascript:alert(1)", "Outline", undefined, async () => true).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(invalid).toBeInstanceOf(Error)
    expect(downloads).toEqual([])
  })

  test("a file that could run is saved only after the warning is accepted, and never by its shared name alone", async () => {
    const url = await startServer(200, "#!/bin/sh", {
      "content-type": "application/octet-stream",
      "content-disposition": 'attachment; filename="setup.sh"',
    })
    const downloads = captureDownloads()
    const warnings: string[] = []
    expect(
      await downloadReferenceFile(url, "Notes.pdf", "application/pdf", async () => {
        warnings.push("declined")
        return false
      }),
    ).toBe(false)
    expect(downloads).toEqual([])
    expect(
      await downloadReferenceFile(url, "Notes.pdf", "application/pdf", async () => {
        warnings.push("accepted")
        return true
      }),
    ).toBe(true)
    expect(warnings).toEqual(["declined", "accepted"])
    expect(downloads.map((download) => download.filename)).toEqual(["setup.sh"])
    URL.revokeObjectURL(downloads[0].url)
  })

  test("a file shared under a runnable name or type is warned about even when storage names it otherwise", async () => {
    const url = await startServer(200, "<p>page</p>", {
      "content-type": "text/plain",
      "content-disposition": 'attachment; filename="page.txt"',
    })
    const downloads = captureDownloads()
    let warned = 0
    const allow = async () => {
      warned += 1
      return false
    }
    expect(await downloadReferenceFile(url, "page.html", "text/plain", allow)).toBe(false)
    expect(await downloadReferenceFile(url, "page", "image/svg+xml", allow)).toBe(false)
    expect(warned).toBe(2)
    expect(downloads).toEqual([])
  })
})
