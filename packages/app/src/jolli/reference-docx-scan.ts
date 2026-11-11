import type { DocxUnsupportedContent } from "./reference-docx-types"
import type JSZip from "jszip"

/** DrawingML's namespaces for a diagram (SmartArt) and for a chart, as a `graphicData` `uri`. */
const DIAGRAM_URI = "http://schemas.openxmlformats.org/drawingml/2006/diagram"
const CHART_URIS: ReadonlyArray<string> = [
  "http://schemas.openxmlformats.org/drawingml/2006/chart",
  // Office 2016's newer chart types (waterfall, sunburst, …) live in the `chartex` namespace.
  "http://schemas.microsoft.com/office/drawing/2014/chartex",
]

/** The parts that hold what a reader sees: the body, headers, footers, footnotes and endnotes. */
const CONTENT_PART = /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/
const RELATIONSHIPS_PART = /^word\/_rels\/[^/]+\.rels$/
const EMBEDDED_OBJECT = /<(w:object|o:OLEObject)[\s>/]/
const IMPORTED_DOCUMENT = /<w:altChunk[\s>/]/
/**
 * The `uri` of each `graphicData` element — what a drawing actually holds.
 *
 * ⚠ The namespace must be matched HERE, on a drawing, and never as a bare string in the part: Word
 * 2016 and later declare the `chartex` namespace (`xmlns:cx1=…`) on the root element of every part,
 * chart or no chart, so a document with nothing unusual in it was flagged as holding a chart.
 */
const GRAPHIC_DATA_URI = /graphicData\b[^>]*\buri="([^"]*)"/g
const VECTOR_IMAGE_TARGET = /Target="[^"]*\.(emf|wmf)"/i

/**
 * Which kinds of content in this `.docx` the renderer cannot draw.
 *
 * Read from the package itself, before rendering: the renderer drops these silently, so the only
 * way to tell the reader is to look first. Each kind is checked two ways where Word writes it two
 * ways — a part of its own (`word/diagrams/`, `word/charts/`) and a reference inside the text — so a
 * document is flagged whichever it happens to carry.
 */
export async function docxUnsupportedContent(zip: JSZip): Promise<ReadonlySet<DocxUnsupportedContent>> {
  const found = new Set<DocxUnsupportedContent>()
  const names = Object.keys(zip.files)
  if (names.some((name) => name.startsWith("word/diagrams/"))) {
    found.add("smart-art")
  }
  if (names.some((name) => name.startsWith("word/charts/"))) {
    found.add("chart")
  }
  for (const name of names.filter((candidate) => CONTENT_PART.test(candidate))) {
    const xml = await readPart(zip, name)
    for (const [, uri] of xml.matchAll(GRAPHIC_DATA_URI)) {
      if (uri === DIAGRAM_URI) {
        found.add("smart-art")
      }
      if (CHART_URIS.includes(uri)) {
        found.add("chart")
      }
    }
    if (EMBEDDED_OBJECT.test(xml)) {
      found.add("embedded-object")
    }
    if (IMPORTED_DOCUMENT.test(xml)) {
      found.add("imported-document")
    }
  }
  for (const name of names.filter((candidate) => RELATIONSHIPS_PART.test(candidate))) {
    if (VECTOR_IMAGE_TARGET.test(await readPart(zip, name))) {
      found.add("vector-image")
    }
  }
  return found
}

async function readPart(zip: JSZip, name: string): Promise<string> {
  return (await zip.file(name)?.async("string")) ?? ""
}
