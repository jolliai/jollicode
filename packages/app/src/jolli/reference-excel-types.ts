import type { WorkBook } from "xlsx"

/** One shown row of a worksheet: its number as the sheet labels it, and its visible cells' display text. */
export interface ExcelPreviewRow {
  readonly number: number
  readonly cells: Array<string>
}

/** The bounded, plain-text view of one worksheet; rows and columns its author hid are left out. */
export interface ExcelSheetPreview {
  readonly name: string
  /** The visible columns' letters, as the sheet labels them. */
  readonly columns: Array<string>
  readonly rows: Array<ExcelPreviewRow>
  readonly truncated: boolean
}

export type ExcelMaterialCommand = { kind: "open"; bytes: ArrayBuffer } | { kind: "sheet"; name: string }
export type ExcelMaterialRequest = ExcelMaterialCommand & { id: number }
export type ExcelMaterialResponse = { id: number } & (
  | { kind: "opened"; sheetNames: Array<string>; partial: boolean }
  | { kind: "sheet"; preview: ExcelSheetPreview }
  | { kind: "failed" }
)
/** A request to the worker: queued until the worker is free, then posted with its deadline running. */
export interface ExcelPendingRequest {
  readonly message: ExcelMaterialRequest
  readonly transfer: Array<Transferable>
  resolve(response: ExcelMaterialResponse): void
  reject(error: Error): void
  timer?: ReturnType<typeof setTimeout>
}

/** What the worker posts: an answer to a request, or that its script has loaded and it is listening. */
export type ExcelWorkerMessage = ExcelMaterialResponse | { kind: "ready" }

/** A workbook stays in its worker; only the selected sheet's display cells reach the page. */
export interface ExcelMaterialSession {
  readonly sheetNames: Array<string>
  /** The workbook holds what the preview never draws: charts, pictures, embedded objects. */
  readonly partial: boolean
  readSheet(name: string): Promise<ExcelSheetPreview>
  close(): void
}

/** A workbook as its worker holds it: the file, its directory of sheets, and whether it holds what the grid never draws. */
export interface OpenedExcelWorkbook {
  readonly bytes: ArrayBuffer
  /** Every sheet's name, visibility and kind, and where its cells start — but none of its cells. */
  readonly directory: WorkBook
  readonly partial: boolean
  /** A pre-2007 compound file, whose parser reads every sheet whichever one is asked for. */
  readonly legacy: boolean
  /** A legacy workbook's every sheet, read once at the first sheet asked for and kept for the rest. */
  legacySheets?: WorkBook
}

/** What a workbook package holds, once it is known to expand to no more than the preview will hold. */
export interface ExcelPackageFacts {
  /** Charts, pictures or embedded objects, which the cell grid leaves out. */
  readonly hasUndrawnContent: boolean
}
