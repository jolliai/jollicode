import { afterEach, describe, expect, test } from "bun:test"
import { createServer, type Server } from "node:http"
import { resolveObjectURL } from "node:buffer"
import { ChatFileDownloadError, downloadChatFile, referenceDownloadFilename } from "./reference-download"

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
    expect(await downloadChatFile({ source: url, filename: "Outline", allowExecutable: async () => false })).toBe(true)
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
    const refused = await downloadChatFile({
      source: url,
      filename: "Outline",
      allowExecutable: async () => true,
    }).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(refused).toBeInstanceOf(ChatFileDownloadError)
    expect(refused instanceof ChatFileDownloadError && refused.status).toBe(403)
    const invalid = await downloadChatFile({
      source: "javascript:alert(1)",
      filename: "Outline",
      allowExecutable: async () => true,
    }).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(invalid).toBeInstanceOf(ChatFileDownloadError)
    expect(invalid instanceof ChatFileDownloadError && invalid.status).toBeUndefined()
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
      await downloadChatFile({
        source: url,
        filename: "Notes.pdf",
        mimeType: "application/pdf",
        allowExecutable: async () => {
          warnings.push("declined")
          return false
        },
      }),
    ).toBe(false)
    expect(downloads).toEqual([])
    expect(
      await downloadChatFile({
        source: url,
        filename: "Notes.pdf",
        mimeType: "application/pdf",
        allowExecutable: async () => {
          warnings.push("accepted")
          return true
        },
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
    expect(
      await downloadChatFile({ source: url, filename: "page.html", mimeType: "text/plain", allowExecutable: allow }),
    ).toBe(false)
    expect(
      await downloadChatFile({ source: url, filename: "page", mimeType: "image/svg+xml", allowExecutable: allow }),
    ).toBe(false)
    expect(warned).toBe(2)
    expect(downloads).toEqual([])
  })

  test("a chat attachment read through the sidecar is saved under the name the sidecar gives it, warned about once", async () => {
    // As the sidecar answers an attachment download: bytes only, named in the disposition.
    const url = await startServer(200, "@echo off", {
      "content-type": "application/octet-stream",
      "content-disposition": "attachment; filename*=UTF-8''setup.cmd",
    })
    const downloads = captureDownloads()
    let warned = 0
    expect(
      await downloadChatFile({
        source: () => fetch(url),
        filename: "setup.cmd.",
        allowExecutable: async () => {
          warned += 1
          return true
        },
      }),
    ).toBe(true)
    expect(warned).toBe(1)
    expect(downloads.map((download) => download.filename)).toEqual(["setup.cmd"])
    expect(await resolveObjectURL(downloads[0].url)?.text()).toBe("@echo off")
    URL.revokeObjectURL(downloads[0].url)
  })

  test("a sidecar refusal and a request that got no answer fail the same way, the refusal with its status", async () => {
    const url = await startServer(404, "Not found")
    const downloads = captureDownloads()
    const refused = await downloadChatFile({
      source: () => fetch(url),
      filename: "notes.pdf",
      allowExecutable: async () => true,
    }).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(refused instanceof ChatFileDownloadError && refused.status).toBe(404)
    const lost = await downloadChatFile({
      source: () => Promise.reject(new TypeError("Failed to fetch")),
      filename: "notes.pdf",
      allowExecutable: async () => true,
    }).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(lost).toBeInstanceOf(ChatFileDownloadError)
    expect(lost instanceof ChatFileDownloadError && lost.status).toBeUndefined()
    expect(downloads).toEqual([])
  })

  test("a download ended before its bytes arrive is neither confirmed nor saved, and is no failure", async () => {
    const url = await startServer(200, "@echo off", {
      "content-type": "application/octet-stream",
      "content-disposition": 'attachment; filename="setup.cmd"',
    })
    const downloads = captureDownloads()
    const abort = new AbortController()
    const handed: Array<AbortSignal | undefined> = []
    let warned = 0
    const pending = downloadChatFile({
      source: (signal) => {
        handed.push(signal)
        // The page goes while the request is out.
        abort.abort()
        return fetch(url, { signal })
      },
      filename: "setup.cmd",
      allowExecutable: async () => {
        warned += 1
        return true
      },
      signal: abort.signal,
    })
    expect(await pending).toBe(false)
    expect(handed).toEqual([abort.signal])
    expect(warned).toBe(0)
    expect(downloads).toEqual([])
  })

  test("a download ended while the person is asked about a file that could run is not saved when they go ahead", async () => {
    const url = await startServer(200, "@echo off", {
      "content-type": "application/octet-stream",
      "content-disposition": 'attachment; filename="setup.cmd"',
    })
    const downloads = captureDownloads()
    const abort = new AbortController()
    expect(
      await downloadChatFile({
        source: url,
        filename: "setup.cmd",
        allowExecutable: async () => {
          // The account resets while the warning is open; the person then goes ahead.
          abort.abort()
          return true
        },
        signal: abort.signal,
      }),
    ).toBe(false)
    expect(downloads).toEqual([])
  })

  test("an address read is ended by the signal as well", async () => {
    const url = await startServer(200, "Course outline", { "content-type": "text/markdown" })
    const downloads = captureDownloads()
    const abort = new AbortController()
    abort.abort()
    expect(
      await downloadChatFile({
        source: url,
        filename: "Outline",
        allowExecutable: async () => true,
        signal: abort.signal,
      }),
    ).toBe(false)
    expect(downloads).toEqual([])
  })
})
