/**
 * What a `.docx` can hold that the in-browser renderer draws nothing for.
 *
 * - `smart-art`: SmartArt diagrams.
 * - `chart`: native Word charts.
 * - `embedded-object`: OLE objects, such as an Excel chart pasted as an object.
 * - `vector-image`: EMF / WMF pictures, which no browser decodes.
 * - `imported-document`: another file (HTML, RTF, a `.docx`) pulled in whole with `w:altChunk`.
 *   The renderer can draw one only as a nested frame of its own, which the viewer's link rules never
 *   reach, so it is not drawn.
 *
 * Found by scanning the package before it is rendered, so the reader is told rather than shown a
 * document with a hole where the diagram was.
 */
export type DocxUnsupportedContent = "smart-art" | "chart" | "embedded-object" | "vector-image" | "imported-document"
