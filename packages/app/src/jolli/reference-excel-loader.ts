import type {
  ExcelMaterialCommand,
  ExcelMaterialResponse,
  ExcelMaterialSession,
  ExcelPendingRequest,
  ExcelWorkerMessage,
} from "./reference-excel-types"
import { Option } from "effect"
import { READER_EXCEL_START_TIMEOUT_MS, READER_EXCEL_TIMEOUT_MS } from "./reference-reader-limits"

/**
 * One worksheet the parser could not read. The workbook, and the worker holding it, are as they were:
 * the other sheets can still be shown.
 */
export class ExcelSheetReadError extends Error {
  constructor() {
    super("Excel worksheet failed")
    this.name = "ExcelSheetReadError"
  }
}

/**
 * Start a private, killable parser for one open material. Aborting releases its workbook and requests.
 *
 * ⚠ One request reaches the worker at a time, and its deadline starts when it is posted. The worker
 * answers in order, so a deadline started when a request was queued counted the requests ahead of it
 * — a few quick clicks between sheets timed out a sheet that had not begun. And a sheet asked for is
 * the only one still wanted: one still queued is dropped, never parsed, when another is asked for.
 *
 * ⚠ `bytes` is handed to the worker rather than copied when it is a whole buffer of its own, which
 * is what a read hands back, so the caller must not use it afterwards.
 */
export async function openExcelMaterial(bytes: Uint8Array, signal: AbortSignal): Promise<ExcelMaterialSession> {
  const worker = new Worker(new URL("./reference-excel.worker.ts", import.meta.url), { type: "module" })
  let nextId = 0
  let stopped = false
  let ready = false
  let inFlight: ExcelPendingRequest | undefined
  const queued: Array<ExcelPendingRequest> = []
  const startTimer = setTimeout(close, READER_EXCEL_START_TIMEOUT_MS)

  function close(): void {
    if (stopped) {
      return
    }
    stopped = true
    clearTimeout(startTimer)
    worker.terminate()
    signal.removeEventListener("abort", close)
    for (const request of [...(inFlight ? [inFlight] : []), ...queued.splice(0)]) {
      clearTimeout(request.timer)
      request.reject(new Error("Excel preview closed"))
    }
    inFlight = undefined
  }

  /** Post the next queued request, once the worker is listening and free. */
  function postNext(): void {
    if (!ready || stopped || inFlight) {
      return
    }
    const next = queued.shift()
    if (!next) {
      return
    }
    inFlight = next
    next.timer = setTimeout(close, READER_EXCEL_TIMEOUT_MS)
    // A message the worker cannot be handed closes the preview, as a worker that stopped answering does.
    if (Option.isNone(Option.liftThrowable(() => worker.postMessage(next.message, next.transfer))())) close()
  }

  function request(command: ExcelMaterialCommand, transfer: Array<Transferable> = []): Promise<ExcelMaterialResponse> {
    if (stopped || signal.aborted) {
      return Promise.reject(new Error("Excel preview closed"))
    }
    if (command.kind === "sheet") {
      for (const superseded of queued.filter((entry) => entry.message.kind === "sheet")) {
        queued.splice(queued.indexOf(superseded), 1)
        superseded.reject(new Error("Excel worksheet read superseded"))
      }
    }
    const id = nextId++
    return new Promise((resolve, reject) => {
      queued.push({ message: { ...command, id }, transfer, resolve, reject })
      postNext()
    })
  }

  function handleMessage(event: MessageEvent<ExcelWorkerMessage>): void {
    const message = event.data
    if (message.kind === "ready") {
      if (!ready && !stopped) {
        ready = true
        clearTimeout(startTimer)
        postNext()
      }
      return
    }
    const answered = inFlight
    if (!answered || answered.message.id !== message.id) {
      return
    }
    clearTimeout(answered.timer)
    inFlight = undefined
    if (message.kind !== "failed") {
      answered.resolve(message)
      postNext()
      return
    }
    if (answered.message.kind === "open") {
      answered.reject(new Error("Excel preview failed"))
      close()
      return
    }
    // One sheet the parser could not read leaves the workbook, and the worker holding it, as they were.
    answered.reject(new ExcelSheetReadError())
    postNext()
  }

  worker.onmessage = handleMessage
  worker.onerror = close
  worker.onmessageerror = close
  signal.addEventListener("abort", close, { once: true })
  if (signal.aborted) {
    close()
  }

  const buffer =
    bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer
      : bytes.slice().buffer
  // A workbook that does not open releases its worker before the failure reaches the caller.
  const opened = await request({ kind: "open", bytes: buffer }, [buffer]).catch((error: unknown) => {
    close()
    throw error
  })
  if (opened.kind !== "opened") {
    close()
    throw new Error("Invalid workbook response")
  }
  return {
    sheetNames: opened.sheetNames,
    partial: opened.partial,
    async readSheet(name) {
      const response = await request({ kind: "sheet", name })
      if (response.kind !== "sheet") {
        throw new Error("Invalid worksheet response")
      }
      return response.preview
    },
    close,
  }
}
