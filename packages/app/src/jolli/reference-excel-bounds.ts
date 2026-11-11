import type { ExcelPackageFacts } from "./reference-excel-types"
import { READER_EXCEL_ENTRIES, READER_EXCEL_INFLATED_BYTES } from "./reference-reader-limits"
import { checkZipPackage } from "./reference-zip-bounds"

/**
 * The parts of a workbook package that hold what the preview never draws. ⚠ Not every drawing part is
 * one: Excel writes a legacy VML drawing (`xl/drawings/vmlDrawing1.vml`) for every cell note and form
 * control, so a gradebook with one note would read as holding a picture.
 */
const UNDRAWN_PARTS = /^xl\/(?:drawings\/(?!(?:_rels\/)?vmlDrawing[^/]*$)|charts\/|chartsheets\/|media\/|embeddings\/)/

/**
 * Refuse a workbook package that would expand past {@link READER_EXCEL_INFLATED_BYTES}, or that holds
 * more than {@link READER_EXCEL_ENTRIES} parts, before the parser is handed it. See
 * {@link checkZipPackage} for why this, and not the page's deadline, keeps a zip bomb from taking the
 * window down.
 */
export async function checkExcelPackage(bytes: Uint8Array<ArrayBuffer>): Promise<ExcelPackageFacts> {
  const names = await checkZipPackage(bytes, {
    inflatedBytes: READER_EXCEL_INFLATED_BYTES,
    entries: READER_EXCEL_ENTRIES,
  })
  return { hasUndrawnContent: names.some((name) => UNDRAWN_PARTS.test(name)) }
}
