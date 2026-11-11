import type {
  ExcelMaterialRequest,
  ExcelMaterialResponse,
  ExcelSheetPreview,
  ExcelWorkerMessage,
  OpenedExcelWorkbook,
} from "./reference-excel-types"
import { excelSheetPreview, excelVisibleSheetNames, openExcelWorkbook, readExcelSheet } from "./reference-excel-data"
import { READER_EXCEL_CACHED_SHEETS } from "./reference-reader-limits"

let opened: OpenedExcelWorkbook | undefined
/**
 * The sheets read most recently, least recent first. A sheet's first read inflates the file again:
 * SheetJS's public `read` takes only the file's bytes, and keeping its unzipped package between reads
 * would mean calling its untyped internals (`CFB`, `parse_zip`) without the option set-up `read` does,
 * and holding every inflated part for as long as the material is open. Going back to a sheet still
 * kept costs nothing. ⚠ Bounded: each can hold millions of characters, in a worker that shares the
 * tab's process.
 */
const previews = new Map<string, ExcelSheetPreview>()
/** One request at a time, in the order they came: opening a workbook takes longer than a click. */
let queue: Promise<void> = Promise.resolve()

/** The workbook never leaves this worker; render data is requested one worksheet at a time. */
async function answer(request: ExcelMaterialRequest): Promise<ExcelMaterialResponse> {
  if (request.kind === "open") {
    previews.clear()
    opened = await openExcelWorkbook(request.bytes)
    return {
      id: request.id,
      kind: "opened",
      sheetNames: excelVisibleSheetNames(opened.directory),
      partial: opened.partial,
    }
  }
  if (!opened) {
    throw new Error("Workbook not opened")
  }
  let preview = previews.get(request.name)
  previews.delete(request.name)
  if (!preview) {
    preview = excelSheetPreview(readExcelSheet(opened, request.name), request.name)
  }
  previews.set(request.name, preview)
  for (const name of previews.keys()) {
    if (previews.size <= READER_EXCEL_CACHED_SHEETS) {
      break
    }
    previews.delete(name)
  }
  return { id: request.id, kind: "sheet", preview }
}

/** Never rejects, so one request cannot stop the queue behind it. */
async function respond(request: ExcelMaterialRequest): Promise<void> {
  let response: ExcelMaterialResponse
  try {
    response = await answer(request)
  } catch {
    response = { id: request.id, kind: "failed" }
  }
  try {
    self.postMessage(response)
  } catch {
    // A reply that cannot be posted is left to the page's deadline for its request.
  }
}

function handleRequest(event: MessageEvent<ExcelMaterialRequest>): void {
  const request = event.data
  queue = queue.then(() => respond(request))
}

self.onmessage = handleRequest
// The page's deadlines start from here, so the time this script took to arrive is not counted against a parse.
self.postMessage({ kind: "ready" } satisfies ExcelWorkerMessage)
