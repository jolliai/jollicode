import type { ExcelPreviewRow, ExcelSheetPreview, OpenedExcelWorkbook } from "./reference-excel-types"
import { checkExcelPackage } from "./reference-excel-bounds"
import {
  READER_EXCEL_CELL_CHARS,
  READER_EXCEL_CHARS,
  READER_EXCEL_COLUMNS,
  READER_EXCEL_ROWS,
} from "./reference-reader-limits"
// By its own path, not the package index: this runs in a worker, which should not carry the whole of common.
import { MATERIAL_MAGIC_PREFIX_BYTES, matchesMaterialContainer } from "./reference-material-container"
import { type ParsingOptions, read, utils, type WorkBook, type WorkSheet } from "xlsx"

/** No HTML, macros or formula evaluation: formulas keep only their stored result or literal expression. */
const PARSING: ParsingOptions = { type: "array", dense: true, cellHTML: false, cellFormula: true }

/**
 * Open a workbook: refuse what is not one, or what would expand past the preview's bound, and read
 * its directory — every sheet's name, visibility and kind and where its cells start, but only the
 * first row of cells. A sheet's cells are read when it is shown, by {@link readExcelSheet}.
 */
export async function openExcelWorkbook(bytes: ArrayBuffer): Promise<OpenedExcelWorkbook> {
  const prefix = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, MATERIAL_MAGIC_PREFIX_BYTES))
  const legacy = matchesMaterialContainer(prefix, "ole2")
  if (!legacy && !matchesMaterialContainer(prefix, "ooxml")) {
    throw new Error("Not an Excel workbook")
  }
  // A compound file is not compressed, so its size already bounds what it parses to. Its charts and
  // pictures are not looked for: nothing short of the parser finds them there.
  const partial = legacy ? false : (await checkExcelPackage(new Uint8Array(bytes))).hasUndrawnContent
  const directory = read(bytes, { ...PARSING, sheetRows: 1 })
  // The BIFF reader does not set bookType; the compound-file check above is its format boundary.
  if (!legacy && directory.bookType !== "xlsx") {
    throw new Error("Not an Excel workbook")
  }
  return { bytes, directory, partial, legacy }
}

/** Keep the workbook's own order without the sheets its author hid, or the ones with no cells: charts, dialogs, macros. */
export function excelVisibleSheetNames(workbook: WorkBook): Array<string> {
  return workbook.SheetNames.filter(
    (name, index) => !workbook.Workbook?.Sheets?.[index]?.Hidden && isWorksheet(workbook.Sheets[name]),
  )
}

/**
 * Read one visible sheet's cells, from the first row it uses.
 *
 * ⚠ The parser's row bound counts from the top of the sheet, not from its first used row. One bound
 * for every sheet cut a sheet that starts lower down short of its window, and showed one that starts
 * below the bound as empty, so each sheet is read again here with a bound that reaches past its own
 * first row, found from the range the directory declares for it.
 *
 * ⚠ Not every writer declares a range (`<dimension>`). With none, and nothing in the first row, the
 * directory cannot say where the cells start, so the sheet is read whole: the package's expansion
 * bound, checked before anything was parsed, is what bounds that read.
 */
export function readExcelSheet(opened: OpenedExcelWorkbook, name: string): WorkBook {
  requireVisibleSheet(opened.directory, name)
  // The rows and columns the author hid are only read with the styles.
  const parsing: ParsingOptions = { ...PARSING, cellStyles: true }
  // ⚠ The compound-file parser ignores `sheets` and reads every sheet each time, so a large `.xls`
  // read again for each tab ran past the worker's deadline. It is read once, far enough for every
  // visible sheet's window, and each tab after the first is a lookup.
  if (opened.legacy) {
    opened.legacySheets ??= read(opened.bytes, withSheetRows(parsing, excelVisibleSheetNames(opened.directory), opened))
    return opened.legacySheets
  }
  return read(opened.bytes, withSheetRows({ ...parsing, sheets: name }, [name], opened))
}

/**
 * `parsing`, bounded to the rows that reach past the first used row of every sheet in `names` by the
 * preview's window — or unbounded when one of them declares no range, so nothing says where it starts.
 */
function withSheetRows(
  parsing: ParsingOptions,
  names: ReadonlyArray<string>,
  opened: OpenedExcelWorkbook,
): ParsingOptions {
  let rows = 0
  for (const name of names) {
    const sheet = opened.directory.Sheets[name]
    const declared = sheet?.["!fullref"] ?? sheet?.["!ref"]
    if (declared === undefined) {
      return parsing
    }
    const firstRow = utils.decode_range(declared).s.r
    rows = Math.max(rows, (Number.isSafeInteger(firstRow) && firstRow > 0 ? firstRow : 0) + READER_EXCEL_ROWS + 1)
  }
  return { ...parsing, sheetRows: rows }
}

/** Read one visible worksheet without allocating a table for its unbounded declared range. */
export function excelSheetPreview(workbook: WorkBook, name: string): ExcelSheetPreview {
  requireVisibleSheet(workbook, name)
  const sheet = workbook.Sheets[name]
  if (!sheet["!ref"]) {
    return { name, columns: [], rows: [], truncated: sheet["!fullref"] !== undefined }
  }
  const range = utils.decode_range(sheet["!ref"])
  const fullRange = utils.decode_range(sheet["!fullref"] ?? sheet["!ref"])
  if (
    ![range.s.r, range.s.c, range.e.r, range.e.c].every(Number.isSafeInteger) ||
    range.s.r < 0 ||
    range.s.c < 0 ||
    range.e.r < range.s.r ||
    range.e.c < range.s.c
  ) {
    throw new Error("Invalid worksheet range")
  }
  const columns: Array<number> = []
  let column = range.s.c
  for (; column <= range.e.c && columns.length < READER_EXCEL_COLUMNS; column += 1) {
    if (!sheet["!cols"]?.[column]?.hidden) {
      columns.push(column)
    }
  }
  // Every column in the window hidden: nothing to draw, so the sheet reads as empty — and as cut, when a
  // visible column lies past the window.
  if (columns.length === 0) {
    return { name, columns: [], rows: [], truncated: hasVisibleColumn(sheet, column, fullRange.e.c) }
  }
  // Positions, not shown rows: a hidden row uses up its place in the window the sheet was read for.
  const endRow = Math.min(range.e.r, range.s.r + READER_EXCEL_ROWS - 1)
  let truncated = fullRange.e.r > endRow || hasVisibleColumn(sheet, column, fullRange.e.c)
  let remainingChars = READER_EXCEL_CHARS
  const rows: Array<ExcelPreviewRow> = []
  for (let rowIndex = range.s.r; rowIndex <= endRow; rowIndex += 1) {
    if (sheet["!rows"]?.[rowIndex]?.hidden) {
      continue
    }
    const cells: Array<string> = []
    for (const index of columns) {
      const text = cellText(sheet, rowIndex, index)
      const shown = text.slice(0, Math.min(READER_EXCEL_CELL_CHARS, remainingChars))
      truncated ||= shown.length < text.length
      cells.push(shown)
      remainingChars -= shown.length
    }
    rows.push({ number: rowIndex + 1, cells })
    if (remainingChars === 0) {
      truncated ||= rowIndex < range.e.r
      break
    }
  }
  return { name, columns: columns.map((index) => utils.encode_col(index)), rows, truncated }
}

function requireVisibleSheet(workbook: WorkBook, name: string): void {
  if (!excelVisibleSheetNames(workbook).includes(name) || !Object.hasOwn(workbook.Sheets, name)) {
    throw new Error("Worksheet not found")
  }
}

/** A chartsheet, dialog sheet or macro sheet is listed among the sheets, and holds nothing the grid can show. */
function isWorksheet(sheet: WorkSheet | undefined): boolean {
  const type = sheet?.["!type"]
  return sheet !== undefined && (type === undefined || type === "sheet")
}

/** Whether any column from `from` to `last` is one the author left visible: a cut that dropped only hidden ones cut nothing. */
function hasVisibleColumn(sheet: WorkSheet, from: number, last: number): boolean {
  for (let column = from; column <= last; column += 1) {
    if (!sheet["!cols"]?.[column]?.hidden) {
      return true
    }
  }
  return false
}

function cellText(sheet: WorkSheet, row: number, column: number): string {
  const cell = sheet["!data"]?.[row]?.[column]
  if (!cell) {
    return ""
  }
  if (cell.v === undefined && cell.f) {
    return `=${cell.f}`
  }
  return cell.w ?? utils.format_cell(cell)
}
