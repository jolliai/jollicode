/** `PK\x05\x06`, the end-of-central-directory record. */
const END_SIGNATURE = 0x06054b50
/** `PK\x01\x02`, one central directory entry. */
const CENTRAL_SIGNATURE = 0x02014b50
/** `PK\x03\x04`, one member's local header. */
const LOCAL_SIGNATURE = 0x04034b50
const END_BYTES = 22
const CENTRAL_HEADER_BYTES = 46
const LOCAL_HEADER_BYTES = 30
/** What a 32-bit size or offset holds when the real one is in a ZIP64 extra field instead. */
const ZIP64_MARKER = 0xffffffff
const ZIP64_EXTRA_ID = 0x0001
/** `PK\x07\x08`, which a data descriptor may open with. */
const DESCRIPTOR_SIGNATURE = 0x08074b50
/** The general-purpose flag saying a member's sizes follow its data, in a data descriptor. */
const FLAG_DATA_DESCRIPTOR = 0x0008
const METHOD_STORED = 0
const METHOD_DEFLATE = 8
/**
 * How much compressed input is handed to the inflater at a time. Deflate expands at most about
 * 1032:1, so one step produces at most about 16 MB however the member was built, and the count can
 * stop the stream between steps instead of after the whole member has been inflated at once.
 */
const INFLATE_CHUNK_BYTES = 16 * 1024

export type ZipPackageLimits = {
  /** The most every member together may expand to. */
  inflatedBytes: number
  /** The most members the package may hold. */
  entries: number
}

/**
 * Refuse a zip package (a workbook or a Word document) that holds more members than
 * `limits.entries` or would expand past `limits.inflatedBytes`, before its parser is handed it.
 * Resolves with each member's name, as its central directory gives it.
 *
 * ⚠ A deadline cannot do this: a parser shares the page's renderer process, and a small zip whose
 * parts inflate to gigabytes exhausts that process's memory — crashing the window — well within the
 * time a real package takes to parse. So the whole directory is read and its declared sizes are
 * bounded before anything is inflated; then every compressed member is inflated as a stream that is
 * counted and thrown away, and the package is refused the moment a member passes the size it
 * declared.
 *
 * ⚠ What is checked must be what the parser reads, and the parsers do not read a package the same
 * way. SheetJS walks exactly the number of entries the end record gives; JSZip walks every central
 * header that follows another, whatever the count, and shifts every offset when the directory does
 * not end where the end record starts (a package with bytes prepended). So the directory must end
 * exactly at the end record, and the entries it gives must fill it exactly: then both parsers walk
 * the same entries this does. The parser inflates from the member's local header for as long as the
 * deflate stream goes, while this inflates exactly the central directory's compressed size; they
 * agree only because that slice must hold the whole stream and nothing after it — a stream cut
 * short, or one followed by more bytes, fails `DecompressionStream`, as the Compression Streams
 * standard requires — and because every size a header gives must match the others: the local
 * header's, or the data descriptor's for a member written as a stream, and what the member actually
 * inflated to. A package whose headers disagree is refused rather than trusted to be read the same
 * way twice.
 *
 * Throws for anything this cannot vouch for: no end record, a multi-disk or ZIP64 package, a member
 * past the end of the file, headers that disagree, or a compression method the parsers cannot read
 * either.
 */
export async function checkZipPackage(bytes: Uint8Array<ArrayBuffer>, limits: ZipPackageLimits) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const end = endOfDirectory(view)
  if (end + END_BYTES > view.byteLength) throw new Error("Malformed zip package")
  // A multi-disk or ZIP64 end record makes JSZip read a directory other than the one checked here.
  if (view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0)
    throw new Error("Multi-disk zip packages are not read")
  // The parser counts this disk's entries; the archive's total sits beside it. Told apart, the
  // check would walk one directory and the parser another.
  const count = view.getUint16(end + 8, true)
  if (count !== view.getUint16(end + 10, true)) throw new Error("Malformed zip package")
  if (count > limits.entries) throw new Error("Zip package holds more members than the preview reads")
  const directory = view.getUint32(end + 16, true)
  if (directory + view.getUint32(end + 12, true) !== end) throw new Error("Malformed zip package")

  const names = new TextDecoder()
  const members: { name: string; method: number; size: number; data: Uint8Array<ArrayBuffer> }[] = []
  let declared = 0
  let at = directory
  for (let index = 0; index < count; index += 1) {
    requireSignature(view, at, CENTRAL_SIGNATURE)
    const flags = view.getUint16(at + 8, true)
    const method = view.getUint16(at + 10, true)
    const compressedSize = view.getUint32(at + 20, true)
    const size = view.getUint32(at + 24, true)
    const nameLength = view.getUint16(at + 28, true)
    const extraLength = view.getUint16(at + 30, true)
    const commentLength = view.getUint16(at + 32, true)
    const local = view.getUint32(at + 42, true)
    if (compressedSize === ZIP64_MARKER || size === ZIP64_MARKER || local === ZIP64_MARKER)
      throw new Error("ZIP64 packages are not read")
    // Encrypted members are refused by every parser that would be handed them.
    if ((flags & 0x0001) !== 0) throw new Error("Encrypted zip packages are not read")
    if (method !== METHOD_DEFLATE && method !== METHOD_STORED) throw new Error("Unsupported compression method")
    const nameStart = at + CENTRAL_HEADER_BYTES

    requireSignature(view, local, LOCAL_SIGNATURE)
    const localFlags = view.getUint16(local + 6, true)
    const localCompressedSize = view.getUint32(local + 18, true)
    const localSize = view.getUint32(local + 22, true)
    const localNameLength = view.getUint16(local + 26, true)
    const localExtraLength = view.getUint16(local + 28, true)
    const localExtra = local + LOCAL_HEADER_BYTES + localNameLength
    if (hasZip64Extra(view, localExtra, localExtraLength) || hasZip64Extra(view, nameStart + nameLength, extraLength))
      throw new Error("ZIP64 packages are not read")
    declared += Math.max(size, localSize)
    const dataStart = localExtra + localExtraLength
    if (declared > limits.inflatedBytes || dataStart + compressedSize > bytes.byteLength)
      throw new Error("Zip package is out of bounds")
    const [givenCompressedSize, givenSize] =
      (localFlags & FLAG_DATA_DESCRIPTOR) !== 0
        ? descriptorSizes(view, dataStart + compressedSize)
        : [localCompressedSize, localSize]
    if (givenCompressedSize !== compressedSize || givenSize !== size) throw new Error("Zip package headers disagree")
    if (method === METHOD_STORED && compressedSize !== size) throw new Error("Zip package headers disagree")
    members.push({
      name: names.decode(bytes.subarray(nameStart, nameStart + nameLength)),
      method,
      size,
      data: bytes.subarray(dataStart, dataStart + compressedSize),
    })
    at = nameStart + nameLength + extraLength + commentLength
  }
  // JSZip reads on while central headers follow one another, so nothing may sit between the last
  // entry counted here and the end record.
  if (at !== end) throw new Error("Malformed zip package")

  for (const member of members) {
    if (member.method !== METHOD_DEFLATE) continue
    // The declared sizes already fit the bound, so stopping each member at its own size bounds the whole.
    if ((await inflatedSize(member.data, member.size)) !== member.size) throw new Error("Zip package headers disagree")
  }
  return members.map((member) => member.name)
}

/**
 * Where the end record starts, found exactly as the parsers find it: the last `PK\x05\x06` in the
 * file, searched from four bytes before its end, however far back that is.
 *
 * ⚠ Searching any other way is a bypass, not a style choice. A package can carry two end records
 * — a real one, and a forged one in the archive comment after it — and whichever this check reads,
 * the parser must read too; otherwise this vouches for one directory while the parser inflates the
 * other. A forged record too close to the end to hold its fields is refused by the caller.
 */
function endOfDirectory(view: DataView): number {
  for (let at = view.byteLength - 4; at >= 0; at -= 1) {
    if (view.getUint32(at, true) === END_SIGNATURE) return at
  }
  throw new Error("Not a zip package")
}

/** The compressed and uncompressed sizes a data descriptor at `at` gives, its signature optional. */
function descriptorSizes(view: DataView, at: number): [number, number] {
  const fields = view.getUint32(at, true) === DESCRIPTOR_SIGNATURE ? at + 4 : at
  return [view.getUint32(fields + 4, true), view.getUint32(fields + 8, true)]
}

function requireSignature(view: DataView, at: number, signature: number) {
  if (at + 4 > view.byteLength || view.getUint32(at, true) !== signature) throw new Error("Malformed zip package")
}

/** Whether an extra field carries ZIP64 sizes, which the parser would believe over the ones checked here. */
function hasZip64Extra(view: DataView, start: number, length: number) {
  for (let at = start; at + 4 <= start + length; at += 4 + view.getUint16(at + 2, true)) {
    if (view.getUint16(at, true) === ZIP64_EXTRA_ID) return true
  }
  return false
}

/** How many bytes a raw deflate stream expands to, read and discarded; throws once it passes `limit`. */
async function inflatedSize(compressed: Uint8Array<ArrayBuffer>, limit: number) {
  let offset = 0
  const source = new ReadableStream<BufferSource>({
    pull(controller) {
      if (offset >= compressed.byteLength) {
        controller.close()
        return
      }
      controller.enqueue(compressed.subarray(offset, offset + INFLATE_CHUNK_BYTES))
      offset += INFLATE_CHUNK_BYTES
    },
  })
  const reader = source.pipeThrough(new DecompressionStream("deflate-raw")).getReader()
  let size = 0
  for (;;) {
    const part = await reader.read()
    if (part.done) return size
    size += part.value.byteLength
    if (size > limit) {
      await reader.cancel()
      throw new Error("Zip package expands past what it declares")
    }
  }
}
