import JSZip from "jszip"
import { mapSymbolBullets } from "./reference-docx-bullets"
import { docxUnsupportedContent } from "./reference-docx-scan"
import { READER_DOCX_ENTRIES, READER_DOCX_INFLATED_BYTES } from "./reference-reader-limits"
import { checkZipPackage } from "./reference-zip-bounds"

/**
 * A `.docx` made ready for the renderer: refused when it holds too many parts or would expand past
 * what the preview holds, then scanned for what the renderer cannot draw, with Word's private-use
 * bullets mapped to characters a browser has.
 *
 * ⚠ The bound is checked before JSZip opens the package. JSZip inflates a member in full before it
 * compares the member's size, and the renderer opens the package again and parses its XML on the
 * page's own thread, so an unchecked package could stall or exhaust the window before either noticed.
 */
export async function prepareDocxPackage(bytes: Uint8Array<ArrayBuffer>) {
  await checkZipPackage(bytes, { inflatedBytes: READER_DOCX_INFLATED_BYTES, entries: READER_DOCX_ENTRIES })
  const zip = await JSZip.loadAsync(bytes)
  const unsupported = await docxUnsupportedContent(zip)
  const numbering = zip.file("word/numbering.xml")
  if (numbering) {
    const xml = await numbering.async("string")
    const mapped = mapSymbolBullets(xml)
    if (mapped !== xml) zip.file("word/numbering.xml", mapped)
  }
  return { bytes: await zip.generateAsync({ type: "uint8array" }), unsupported }
}
