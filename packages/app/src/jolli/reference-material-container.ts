/** Office container checks from the web reader, limited to the workbook formats used here. */
export const MATERIAL_MAGIC_PREFIX_BYTES = 8192

const ZIP_MAGIC: ReadonlyArray<number> = [0x50, 0x4b, 0x03, 0x04] // "PK\x03\x04"

const OLE2_MAGIC: ReadonlyArray<number> = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]

const OOXML_FIRST_ENTRY_NAMES: ReadonlyArray<string> = [
  "[content_types].xml",
  "_rels/",
  "docprops/",
  "customxml/",
  "word/",
  "xl/",
  "ppt/",
]

function startsWith(bytes: Uint8Array, magic: ReadonlyArray<number>): boolean {
  if (bytes.length < magic.length) {
    return false
  }
  for (let index = 0; index < magic.length; index++) {
    if (bytes[index] !== magic[index]) {
      return false
    }
  }
  return true
}

function firstZipEntryName(bytes: Uint8Array): string | undefined {
  const nameLengthAt = 26
  const nameAt = 30
  if (bytes.length < nameAt) {
    return undefined
  }
  // Through a DataView rather than by hand, so the two-byte read is one expression with
  // no bounds fallback of its own — the guard above is what makes it safe, and a second
  // defence beside it would be a branch nothing can ever take.
  const nameLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(nameLengthAt, true)
  if (nameLength === 0 || bytes.length < nameAt + nameLength) {
    return undefined
  }
  // Lowercased because the package's own spelling is a convention, not a rule —
  // `docProps/` is mixed case to begin with — and nothing here turns on which.
  return new TextDecoder("utf-8").decode(bytes.subarray(nameAt, nameAt + nameLength)).toLowerCase()
}

function looksLikeOoxml(bytes: Uint8Array): boolean {
  const first = firstZipEntryName(bytes)
  if (first !== undefined && OOXML_FIRST_ENTRY_NAMES.some((name) => first.startsWith(name))) {
    return true
  }
  return new TextDecoder("utf-8").decode(bytes.subarray(0, 512)).includes("[Content_Types].xml")
}

function isOoxml(bytes: Uint8Array): boolean {
  return startsWith(bytes, ZIP_MAGIC) && looksLikeOoxml(bytes)
}

function isOle2(bytes: Uint8Array): boolean {
  return startsWith(bytes, OLE2_MAGIC)
}

export function matchesMaterialContainer(bytes: Uint8Array, expected: "ooxml" | "ole2"): boolean {
  if (expected === "ooxml") return isOoxml(bytes)
  if (expected === "ole2") return isOle2(bytes)
  return false
}
