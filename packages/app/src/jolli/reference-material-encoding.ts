/**
 * Reading a course material's bytes as text: UTF-16 by its byte-order mark, UTF-8 when the bytes
 * are valid UTF-8 or nearly so, GBK, Big5, Shift_JIS or EUC-JP when they are recognisably one of
 * those, and otherwise Windows-1252.
 *
 * # Why this lives in `common`
 *
 * Three places read these bytes as text and all three must agree: the container check, which
 * both the browser (before the upload) and the server (after it) run to decide a file is text
 * at all; the server's text extractor, which stores the words search and the assistants read;
 * and the browser's material reader, which draws them. A file the check lets in as text that
 * either reader then decodes as Windows-1252 is a wall of `ÿþ` and gaps, and a reader that
 * decodes a file differently from the extractor shows a student words the assistant never read.
 *
 * # UTF-16 only with a byte-order mark
 *
 * What writes UTF-16 on a teacher's machine writes the mark: Excel's "Unicode Text", Notepad's
 * "Unicode", and Windows PowerShell's redirection. Without one, UTF-16 is recognisable only by
 * guessing from where the zero bytes fall, and a binary file is full of zero bytes too — so a
 * file with no mark is left to the byte-level text rules, which refuse it.
 *
 * ⚠ Uint8Array rather than Buffer, because a browser has no Buffer — and a Buffer is a
 * Uint8Array, so the server passes its own without converting.
 */

const UTF8_BOM: ReadonlyArray<number> = [0xef, 0xbb, 0xbf]

/** Most bytes one character can take in UTF-8. */
const MAX_UTF8_BYTES_PER_CHAR = 4

/**
 * The 0x80–0x9F range, which is the whole of what Windows-1252 adds to ISO-8859-1 — and exactly
 * where Word and Excel put curly quotes, dashes and the euro sign.
 *
 * Written out rather than left to `new TextDecoder("windows-1252")`, whose handling of this one
 * range is not stable across the platforms this runs on: browsers and Node 26 decode it as the
 * characters below, Node 24 — which the tests run in — as the C1 control characters ISO-8859-1 has
 * there. Since that range is the only reason this decoder is Windows-1252 rather than ISO-8859-1,
 * deferring to the platform would decide nothing, and could not be tested.
 *
 * The five bytes Windows-1252 leaves unassigned — 0x81, 0x8D, 0x8F, 0x90, 0x9D — are absent, which
 * keeps each as the code point of its own byte, as the encoding standard asks for.
 */
const WINDOWS_1252_HIGH_RANGE: ReadonlyMap<number, string> = new Map([
  [0x80, "\u20ac"],
  [0x82, "\u201a"],
  [0x83, "\u0192"],
  [0x84, "\u201e"],
  [0x85, "\u2026"],
  [0x86, "\u2020"],
  [0x87, "\u2021"],
  [0x88, "\u02c6"],
  [0x89, "\u2030"],
  [0x8a, "\u0160"],
  [0x8b, "\u2039"],
  [0x8c, "\u0152"],
  [0x8e, "\u017d"],
  [0x91, "\u2018"],
  [0x92, "\u2019"],
  [0x93, "\u201c"],
  [0x94, "\u201d"],
  [0x95, "\u2022"],
  [0x96, "\u2013"],
  [0x97, "\u2014"],
  [0x98, "\u02dc"],
  [0x99, "\u2122"],
  [0x9a, "\u0161"],
  [0x9b, "\u203a"],
  [0x9c, "\u0153"],
  [0x9e, "\u017e"],
  [0x9f, "\u0178"],
])

/** Bytes turned into characters at a time by the Windows-1252 fallback: well under any engine's argument limit. */
const LATIN1_CHUNK = 8192

/**
 * The text in `bytes`, as written — nothing trimmed: UTF-16 when they open with its byte-order
 * mark, UTF-8 when they are valid UTF-8, and otherwise the encoding {@link recognisedLegacyEncodingOf}
 * recognises, Windows-1252 when it recognises none.
 *
 * `truncated` says these are only the first of the file's bytes, which licenses cutting a
 * character the read stopped in the middle of. Doing that unconditionally would drop the last
 * character of a whole file that happens to end in a multi-byte one.
 */
export function decodeMaterialText(bytes: Uint8Array, options: { truncated: boolean }): string {
  return readMaterialText(bytes, options).text
}

/**
 * How a material's text file was read: `utf-8` when its bytes were valid UTF-8, the encoding
 * {@link recognisedLegacyEncodingOf} recognised when they were not, and `unrecognised` when they
 * were read as Windows-1252 only because they were nothing else this knows.
 *
 * Recorded beside the words a reading stores, because it is the one fact about a file that decides
 * whether a retrieval engine is handed it converted: a file in a recognised legacy encoding is, one
 * in UTF-8 or in an encoding this does not know goes as it is.
 */
export type MaterialTextReading = "utf-8" | LegacyTextEncoding | "unrecognised"

/** The text in `bytes`, as {@link decodeMaterialText} reads it, and how it was read. */
export function readMaterialText(
  bytes: Uint8Array,
  options: { truncated: boolean },
): { readonly text: string; readonly reading: MaterialTextReading } {
  const byteOrder = utf16ByteOrder(bytes)
  if (byteOrder !== undefined) {
    return { text: decodeMaterialTextAs(bytes, byteOrder, options), reading: byteOrder }
  }
  let body = stripUtf8Bom(bytes)
  if (options.truncated) {
    body = withoutPartialTrailingUtf8(body)
  }
  try {
    // Strict, so that bytes which are not UTF-8 throw rather than decode as `�`: that is what
    // makes the fallbacks reachable.
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(body), reading: "utf-8" }
  } catch {
    // Not an error: a file saved in a legacy encoding is a supported file, and this is how one
    // is recognised. Windows-1252 is the last resort: every byte is one of its characters.
    const legacy = legacyEncodingOf(body, options)
    return {
      text: decodeMaterialTextAs(body, legacy ?? "windows-1252", options),
      reading: legacy ?? "unrecognised",
    }
  }
}

/**
 * `bytes` read in `encoding` — one {@link recognisedLegacyEncodingOf} named, so that a caller who
 * asked which encoding it is need not have the bytes recognised a second time to read them.
 *
 * Not strict, any of them. UTF-16: the container check read only the first eight kilobytes, and one
 * unpaired surrogate further in should cost one character, not the file's text. The rest: their
 * recognition read the first part, and one malformed character further in should cost one character
 * too. A read that stopped mid-character leaves a replacement character at the end, which is dropped
 * when the read is known to have stopped short.
 */
export function decodeMaterialTextAs(
  bytes: Uint8Array,
  encoding: LegacyTextEncoding,
  options: { truncated: boolean },
): string {
  if (encoding === "utf-16le" || encoding === "utf-16be") {
    return decodeUtf16Text(bytes, encoding, { truncated: options.truncated, fatal: false })
  }
  const body = stripUtf8Bom(bytes)
  if (encoding === "windows-1252") {
    return decodeWindows1252(body)
  }
  const text = new TextDecoder(encoding === "utf-8-damaged" ? "utf-8" : encoding).decode(body)
  return options.truncated ? text.replace(/\ufffd+$/, "") : text
}

/**
 * The legacy multi-byte encodings a teacher's file can be in, named as `TextDecoder` names them.
 *
 * What Notepad and Excel wrote before they defaulted to UTF-8, on a Chinese, Taiwanese or Japanese
 * Windows: GBK (read as GB18030, its superset), Big5 and Shift_JIS — and EUC-JP, what Japanese text
 * on Unix and on older web pages was saved in. EUC-KR is deliberately absent: its byte structure is
 * GB2312's, so every Korean file is also a well-formed GBK one, and reading it as one turns Korean
 * into Chinese — which is worse than the Windows-1252 nonsense it would replace, because it looks
 * like text. {@link legacyCjkEncodingOf} recognises a Korean file in order to read it as none of these.
 */
export type LegacyCjkEncoding = "gb18030" | "big5" | "shift_jis" | "euc-jp"

/** An encoding {@link decodeMaterialText} reads bytes that are not UTF-8 as, having recognised it. */
export type LegacyTextEncoding = Utf16ByteOrder | "utf-8-damaged" | LegacyCjkEncoding | "windows-1252"

/** Every {@link LegacyTextEncoding}: what a file is read in when it is recognised but not UTF-8. */
export const LEGACY_TEXT_ENCODINGS: ReadonlyArray<LegacyTextEncoding> = [
  "utf-16le",
  "utf-16be",
  "utf-8-damaged",
  "gb18030",
  "big5",
  "shift_jis",
  "euc-jp",
  "windows-1252",
]

/**
 * The encoding {@link decodeMaterialText} reads `bytes` as, when they are not UTF-8 and it actually
 * recognises one — or undefined when its Windows-1252 reading would only be a last resort. Read them
 * in it with {@link decodeMaterialTextAs}.
 *
 * Meaningful only for bytes that are not valid UTF-8; the caller asks that first.
 *
 * - **UTF-8 with damage** — `"utf-8-damaged"` — is UTF-8 that a stray byte or two keeps from being valid: a
 *   smart quote pasted from a Windows program, two exports run together. Most of its bytes above
 *   ASCII still form well-made UTF-8 characters, which text in any other encoding makes only by
 *   chance. Read as Windows-1252, every one of those characters would turn into two of nonsense.
 * - **A legacy CJK encoding** — see {@link legacyCjkEncodingOf}.
 * - **Windows-1252 is recognised by its shape, not assumed** — see {@link looksLikeWindows1252}.
 *   Bytes it is only the last resort for — Cyrillic in Windows-1251, Greek, Korean in EUC-KR,
 *   Turkish in Windows-1254 — are nonsense read as it, and a reader that can tell them apart, a
 *   retrieval engine's own charset detection, has to be left to read them as they are.
 */
export function recognisedLegacyEncodingOf(
  bytes: Uint8Array,
  options: { truncated: boolean },
): LegacyTextEncoding | undefined {
  return utf16ByteOrder(bytes) ?? legacyEncodingOf(stripUtf8Bom(bytes), options)
}

/** {@link recognisedLegacyEncodingOf}, of bytes with no byte-order mark. */
function legacyEncodingOf(
  body: Uint8Array,
  options: { truncated: boolean },
): "utf-8-damaged" | LegacyCjkEncoding | "windows-1252" | undefined {
  const sample = legacySampleOf(body).sample
  if (looksLikeDamagedUtf8(sample)) {
    return "utf-8-damaged"
  }
  return legacyCjkEncodingOf(body, options) ?? (looksLikeWindows1252(sample) ? "windows-1252" : undefined)
}

/**
 * Whether bytes that are not valid UTF-8 are UTF-8 all the same, with a little damage: more of their
 * characters above ASCII well-made UTF-8 than not.
 *
 * Text in another encoding forms a well-made UTF-8 character only where a byte in 0xC2–0xF4 happens
 * to be followed by the right number in 0x80–0xBF. Western text in Windows-1252 almost never does
 * that — an accented capital before a symbol — and GBK does it for a minority of its characters at
 * most, so neither passes for the majority.
 */
function looksLikeDamagedUtf8(bytes: Uint8Array): boolean {
  let wellMade = 0
  let stray = 0
  let index = 0
  while (index < bytes.length) {
    if (bytes[index] < 0x80) {
      index++
      continue
    }
    const length = wellMadeUtf8LengthAt(bytes, index)
    if (length === 0) {
      stray++
      index++
      continue
    }
    wellMade++
    index += length
  }
  return wellMade > stray
}

/** How many bytes the well-made UTF-8 character at `index` takes, or 0 when there is not one there. */
function wellMadeUtf8LengthAt(bytes: Uint8Array, index: number): number {
  const lead = bytes[index]
  const length = wellMadeUtf8Length(lead)
  if (length === 0 || index + length > bytes.length) {
    return 0
  }
  const second = bytes[index + 1]
  const [low, high] = secondByteRange(lead)
  if (second < low || second > high) {
    return 0
  }
  for (let offset = 2; offset < length; offset++) {
    if ((bytes[index + offset] & 0b1100_0000) !== 0b1000_0000) {
      return 0
    }
  }
  return length
}

/** How many bytes a well-made UTF-8 character starting with `lead` takes, or 0 when none starts with it. */
function wellMadeUtf8Length(lead: number): number {
  if (lead >= 0xc2 && lead <= 0xdf) {
    return 2
  }
  if (lead >= 0xe0 && lead <= 0xef) {
    return 3
  }
  if (lead >= 0xf0 && lead <= 0xf4) {
    return 4
  }
  return 0
}

/**
 * The bytes that may follow `lead` in a well-made UTF-8 character. Narrower than a continuation
 * byte's after these four leads, which is what keeps overlong forms, surrogates and code points past
 * U+10FFFF out, as a strict decoder does.
 */
function secondByteRange(lead: number): readonly [number, number] {
  switch (lead) {
    case 0xe0:
      return [0xa0, 0xbf]
    case 0xed:
      return [0x80, 0x9f]
    case 0xf0:
      return [0x90, 0xbf]
    case 0xf4:
      return [0x80, 0x8f]
    default:
      return [0x80, 0xbf]
  }
}

/**
 * Whether bytes that are not UTF-8 read as Western text in Windows-1252.
 *
 * ⚠ **Two things, because the other single-byte encodings for Latin script decode as it too**,
 * without complaint and into the wrong letters — Turkish `ışık` as `ýþýk`, Polish `może` as `mo¿e`:
 *
 * 1. **Fewer bytes above ASCII than ASCII letters.** In Western text the letters above ASCII are
 *    the few accented ones among many plain ones — `café`, `Größe`. In a single-byte encoding for
 *    another alphabet, or in Korean, nearly every letter is above ASCII.
 * 2. **Few of its bytes above ASCII are ones Western text has no use for** — under
 *    {@link MAX_NON_WESTERN_SHARE} of them. Three kinds are:
 *    - Ð Ý Þ ð ý þ. Only Icelandic and Faroese write them, and at the same six bytes Windows-1254
 *      keeps Turkish's `ğ ı ş`, Windows-1250 Czech and Slovak's `ý` and Romanian's `ţ`, and
 *      Windows-1257 Lithuanian's `š ž ż` — among the commonest letters of each.
 *    - A byte Windows-1252 leaves undefined — 0x81, 0x8D, 0x8F, 0x90, 0x9D — which no Windows
 *      program writes into it, and which Windows-1250 uses for Czech's `ť` and Polish's `Ź`.
 *    - A symbol between two letters of a word. Western text sets its symbols between words — `«`,
 *      `°`, `£` — and inside one its apostrophes, dashes, ellipsis, the marks a name carries,
 *      Catalan's middle dot and a soft hyphen. Where Windows-1250 keeps Polish's `ą ł ż` and Romanian's `ş`, Windows-1252 keeps
 *      `¹ ³ ¿ º`, which a Western word does not have between two letters.
 *
 * ⚠ **A share, not a single sighting.** One `Þór` quoted in a French handout, or one
 * `Microsoft®Office`, is a Western file that happens to hold one; in the encodings this tells apart
 * those bytes are among the commonest letters, and make up a large part of every file.
 *
 * Icelandic text in Windows-1252 is refused by the second, which costs it nothing it had: it is
 * left as it was stored, as everything this does not recognise is.
 */
function looksLikeWindows1252(bytes: Uint8Array): boolean {
  const high = highByteCount(bytes)
  if (high >= asciiLetterCount(bytes)) {
    return false
  }
  let nonWestern = 0
  for (let index = 0; index < bytes.length; index++) {
    const byte = bytes[index]
    if (byte < 0x80) {
      continue
    }
    if (NON_WESTERN_BYTES.has(byte)) {
      nonWestern++
      continue
    }
    if (isWindows1252Letter(byte) || WINDOWS_1252_IN_WORD_MARKS.has(byte)) {
      continue
    }
    const before = index > 0 ? bytes[index - 1] : 0
    const after = index + 1 < bytes.length ? bytes[index + 1] : 0
    if (isWindows1252WordLetter(before) && isWindows1252WordLetter(after)) {
      nonWestern++
    }
  }
  return nonWestern / high < MAX_NON_WESTERN_SHARE
}

/**
 * Of the bytes above ASCII, the share Western text has no use for at which it is taken to be another
 * encoding — see {@link looksLikeWindows1252}. Turkish writes `ı ş ğ` in well over a tenth of its
 * accented letters, Polish `ą ł ż` likewise; a Western file holds one such byte by accident at most.
 */
const MAX_NON_WESTERN_SHARE = 0.05

/** Ð Ý Þ ð ý þ, and the five bytes Windows-1252 leaves undefined — see {@link looksLikeWindows1252}. */
const NON_WESTERN_BYTES: ReadonlySet<number> = new Set([
  0xd0, 0xdd, 0xde, 0xf0, 0xfd, 0xfe, 0x81, 0x8d, 0x8f, 0x90, 0x9d,
])

/** The letters Windows-1252 keeps below 0xC0: ƒ Š Œ Ž š œ ž Ÿ. */
const WINDOWS_1252_LETTERS_BELOW_C0: ReadonlySet<number> = new Set([0x83, 0x8a, 0x8c, 0x8e, 0x9a, 0x9c, 0x9e, 0x9f])

/**
 * What Western text sets inside a word, or against one: ‘ ’ – —, an ellipsis (`wait…what`), the
 * marks a name carries (`Microsoft®Office`, `™`, `©`), the middle dot of Catalan's `l·l`, a soft
 * hyphen, a no-break space. Windows-1250 keeps every one of these at the same byte, so admitting
 * them costs nothing in telling the two apart.
 */
const WINDOWS_1252_IN_WORD_MARKS: ReadonlySet<number> = new Set([
  0x91, 0x92, 0x85, 0x96, 0x97, 0xae, 0x99, 0xa9, 0xb7, 0xad, 0xa0,
])

/** A letter above ASCII in Windows-1252: 0xC0 and up but × and ÷, and the few below. */
function isWindows1252Letter(byte: number): boolean {
  return (byte >= 0xc0 && byte !== 0xd7 && byte !== 0xf7) || WINDOWS_1252_LETTERS_BELOW_C0.has(byte)
}

function isWindows1252WordLetter(byte: number): boolean {
  return isAsciiLetter(byte) || isWindows1252Letter(byte)
}

function isAsciiLetter(byte: number): boolean {
  return (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a)
}

/** How much of a file the recognition reads. A paragraph decides it; the rest is decoded, not inspected. */
const LEGACY_SAMPLE_BYTES = 64 * 1024

/** How much of the plain ASCII before a file's first byte above ASCII its sample keeps. */
const SAMPLE_CONTEXT_BYTES = LEGACY_SAMPLE_BYTES / 2

/**
 * The part of a file its encoding is recognised from: {@link LEGACY_SAMPLE_BYTES} of it, reaching
 * at most {@link SAMPLE_CONTEXT_BYTES} back from its first byte above ASCII.
 *
 * ⚠ **Not simply its first bytes.** A Windows-1252 gradebook can be plain ASCII for longer than
 * the sample — a wide header, a hundred rows of ids — and reach its accented names after. Its first
 * bytes would hold nothing to recognise, and it would be called unrecognised for good.
 *
 * ⚠ **Nor starting at that byte**, because Western text is told by its plain letters as well as its
 * accented ones: a sample opening on the file's last accented letter would hold almost no letters
 * beside it, and fail the count it is judged by. Every byte before the first one above ASCII is
 * ASCII, so in every encoding here the sample may start anywhere there without cutting a character.
 */
function legacySampleOf(bytes: Uint8Array): { readonly sample: Uint8Array; readonly endsBeforeFile: boolean } {
  const first = bytes.findIndex((byte) => byte >= 0x80)
  const start = Math.max(0, first - SAMPLE_CONTEXT_BYTES)
  const sample = bytes.subarray(start, start + LEGACY_SAMPLE_BYTES)
  return { sample, endsBeforeFile: start + sample.length < bytes.length }
}

/** Of the bytes above ASCII, the share that must sit next to another one for the text to be multi-byte at all. */
const MIN_PAIRED_HIGH_BYTES = 0.5

/**
 * The fewest bytes above ASCII worth recognising an encoding from: two two-byte characters. One
 * accented letter beside another decodes as some Han character in every one of these encodings.
 */
const MIN_HIGH_BYTES = 4

/** Of GBK's two-byte characters, the share that must be GB2312's for a file to be simplified Chinese outright. */
const MIN_GB2312_SHARE = 0.8

/** Of the characters past ASCII, the share that must belong to the script an encoding is for. */
const MIN_SCRIPT_SHARE = 0.9

/**
 * Of the two-byte characters, the share whose bytes are both 0xA1–0xFE, as every EUC-KR character's
 * are. Big5 writes four in ten of its characters with a second byte in the ASCII range.
 */
const MIN_EUC_SHAPED_SHARE = 0.95

/** Of the characters in the letter rows (lead 0xB0 and up), the share in EUC-KR's Hangul rows, 0xB0–0xC8. */
const MIN_HANGUL_ROW_SHARE = 0.95

/**
 * The fewest letter-row characters a Korean verdict is taken from. Simplified Chinese puts about a
 * third of its characters past 0xC8 — \u662f \u6211 \u5728 \u6709 \u8fd9 \u4e2d — so sixteen in a row inside the Hangul rows
 * is a chance of about one in a thousand for Chinese text; a shorter file stays read as Chinese.
 */
const MIN_HANGUL_ROW_CHARACTERS = 16

/**
 * Of the EUC-shaped characters, the share in rows 0xA4 and 0xA5 — hiragana and katakana — that marks
 * a file as Japanese. Japanese text is around half kana; Chinese text all but never writes one.
 */
const MIN_EUC_KANA_SHARE = 0.2

/**
 * Which legacy CJK encoding `bytes` are in, or undefined when they are not recognisably one —
 * which leaves them to Windows-1252, as before.
 *
 * ⚠ **Every one of these encodings decodes almost any bytes without complaint**, Windows-1252 text
 * included — `Noël` is a valid GBK sequence — so "it decodes" decides nothing. Three things do:
 *
 * 1. **Whether the bytes above ASCII come in runs.** In a two-byte encoding a character is a lead
 *    byte above ASCII and, for most characters, a second one too, so they cluster. In Western text
 *    written as Windows-1252 an accented letter stands alone between ASCII ones: `café`, `Noël`.
 *    Below half paired, it is Western text, whatever else it would also decode as.
 * 2. **For GBK, whether the characters are GB2312's.** Simplified Chinese is almost entirely the
 *    6,763 characters and the punctuation of GB2312, both of whose bytes sit at 0xA1 or above. Big5
 *    and Shift_JIS text also decode as GB18030, into rare characters, and far fewer of their pairs
 *    land there.
 * 3. **Whether the decoded text is the script the encoding is for.** Shift_JIS must decode into
 *    Japanese with kana in it — a Big5 file decodes as Shift_JIS into half-width katakana, which no
 *    one writes in a lecture — and Big5 into Han characters and their punctuation.
 *
 * Asked in that order, simplified Chinese first, because that is who uploads these files.
 *
 * ⚠ **Korean is recognised first, to be refused.** EUC-KR has GB2312's byte structure, so a Korean
 * file passes the GBK test above and decodes, strictly, into Chinese characters — and Big5 reads it
 * into Han characters too. What gives it away is where its characters sit: modern Korean is Hangul,
 * every syllable of which EUC-KR writes with a lead byte in 0xB0–0xC8, where Chinese text spreads
 * across 0xB0–0xF7. See {@link looksLikeEucKr}.
 *
 * ⚠ **So is Japanese in EUC-JP, to be read as it.** It has the same structure again, and GB2312 even
 * keeps hiragana and katakana at the very codes EUC-JP does, rows 0xA4 and 0xA5 — so read as GBK a
 * Japanese file keeps its kana and has every kanji turned into some other Chinese character: text
 * that reads as Japanese and says something else. Kana in those rows is what gives it away, and the
 * file is read as EUC-JP when it then decodes as Japanese.
 *
 * ⚠ **A GBK file of nothing but traditional characters reads as Big5**, because it is one: the two
 * encodings give those characters bytes either could have written. Traditional Chinese text is
 * written in Big5 almost everywhere it is written, so that is the reading taken. A GBK file that is
 * mostly simplified, with traditional characters among them, still reads as GBK.
 */
export function legacyCjkEncodingOf(bytes: Uint8Array, options: { truncated: boolean }): LegacyCjkEncoding | undefined {
  const sampled = legacySampleOf(bytes)
  // The sample ends mid-file whenever the file is longer than it, so its last character may be cut.
  const cut = options.truncated || sampled.endsBeforeFile
  if (highByteCount(sampled.sample) < MIN_HIGH_BYTES || pairedHighByteShare(sampled.sample) < MIN_PAIRED_HIGH_BYTES) {
    return undefined
  }
  const pairs = twoByteProfile(sampled.sample)
  if (looksLikeEucKr(pairs)) {
    return undefined
  }
  if (pairs.kanaRows / pairs.eucShaped >= MIN_EUC_KANA_SHARE) {
    const asEucJp = decodeStrictly(sampled.sample, "euc-jp", cut)
    if (asEucJp !== undefined && KANA.test(asEucJp) && scriptShare(asEucJp, JAPANESE) >= MIN_SCRIPT_SHARE) {
      return "euc-jp"
    }
  }
  const asGbk = decodeStrictly(sampled.sample, "gb18030", cut)
  if (asGbk !== undefined && pairs.gb2312 / pairs.characters >= MIN_GB2312_SHARE) {
    return "gb18030"
  }
  const asShiftJis = decodeStrictly(sampled.sample, "shift_jis", cut)
  if (asShiftJis !== undefined && KANA.test(asShiftJis) && scriptShare(asShiftJis, JAPANESE) >= MIN_SCRIPT_SHARE) {
    return "shift_jis"
  }
  const asBig5 = decodeStrictly(sampled.sample, "big5", cut)
  if (asBig5 !== undefined && scriptShare(asBig5, HAN) >= MIN_SCRIPT_SHARE) {
    return "big5"
  }
  // GBK's own extension rows: traditional and rare characters a GB2312 file does not use.
  if (asGbk !== undefined && scriptShare(asGbk, HAN) >= MIN_SCRIPT_SHARE) {
    return "gb18030"
  }
  return undefined
}

/** Han characters and the punctuation, symbols and full-width forms that Chinese text is set in. */
const HAN =
  /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3000-\u303f\uff01-\uff60\uffe0-\uffe6\u2010-\u206f\u00b7\u00d7\u00f7\u25a0-\u25ff\u2460-\u24ff]/u

/** The same, with kana. */
const JAPANESE =
  /[\u3040-\u30ff\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3000-\u303f\uff01-\uff60\uffe0-\uffe6\u2010-\u206f\u00b7\u00d7\u00f7\u25a0-\u25ff]/u

/** Hiragana or full-width katakana — not the half-width katakana a misread Big5 file turns into. */
const KANA = /[\u3040-\u30ff]/u

/** `bytes` decoded strictly, allowing a final character the sample cut in half. Undefined when they do not decode. */
function decodeStrictly(bytes: Uint8Array, encoding: LegacyCjkEncoding, cut: boolean): string | undefined {
  const decoder = new TextDecoder(encoding, { fatal: true })
  // A GB18030 character is at most four bytes, and no other here is longer, so a cut one leaves
  // at most three behind.
  const trims = cut ? [0, 1, 2, 3] : [0]
  for (const trim of trims) {
    try {
      return decoder.decode(bytes.subarray(0, bytes.length - trim))
    } catch {
      // Try a shorter tail, or give up.
    }
  }
  return undefined
}

function highByteCount(bytes: Uint8Array): number {
  let high = 0
  for (const byte of bytes) {
    if (byte >= 0x80) {
      high++
    }
  }
  return high
}

function asciiLetterCount(bytes: Uint8Array): number {
  let letters = 0
  for (const byte of bytes) {
    if (isAsciiLetter(byte)) {
      letters++
    }
  }
  return letters
}

/**
 * Of the bytes above ASCII, the share that has another one beside it.
 *
 * Asked only after {@link MIN_HIGH_BYTES} of them were counted. Of bytes with none it would be NaN,
 * which every threshold compares false against — read as "not paired", the answer that is safe.
 */
function pairedHighByteShare(bytes: Uint8Array): number {
  let high = 0
  let paired = 0
  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] < 0x80) {
      continue
    }
    high++
    if ((index > 0 && bytes[index - 1] >= 0x80) || (index + 1 < bytes.length && bytes[index + 1] >= 0x80)) {
      paired++
    }
  }
  return paired / high
}

/** How the two-byte characters in a sample are spread over the byte ranges that tell encodings apart. */
interface TwoByteProfile {
  /** Every lead byte above ASCII taken with the byte after it. */
  readonly characters: number
  /** Inside GB2312: both bytes 0xA1 or above, the lead no further than its last row of characters. */
  readonly gb2312: number
  /** Both bytes 0xA1–0xFE, the only shape an EUC-KR character has. */
  readonly eucShaped: number
  /** EUC-shaped with a lead of 0xB0 or above: the rows that hold letters rather than symbols. */
  readonly letterRows: number
  /** Of those, the ones with a lead in EUC-KR's Hangul rows, 0xB0–0xC8. */
  readonly hangulRows: number
  /** EUC-shaped in rows 0xA4 and 0xA5, where EUC-JP — and GB2312 — keep hiragana and katakana. */
  readonly kanaRows: number
}

/** `bytes` read as two-byte characters — every lead byte above ASCII with the byte after it. */
function twoByteProfile(bytes: Uint8Array): TwoByteProfile {
  let characters = 0
  let gb2312 = 0
  let eucShaped = 0
  let letterRows = 0
  let hangulRows = 0
  let kanaRows = 0
  let index = 0
  while (index < bytes.length) {
    const lead = bytes[index]
    if (lead < 0x80 || index + 1 >= bytes.length) {
      index++
      continue
    }
    const trail = bytes[index + 1]
    characters++
    if (lead >= 0xa1 && lead <= 0xf7 && trail >= 0xa1 && trail <= 0xfe) {
      gb2312++
    }
    if (lead >= 0xa1 && lead <= 0xfe && trail >= 0xa1 && trail <= 0xfe) {
      eucShaped++
      if (lead === 0xa4 || lead === 0xa5) {
        kanaRows++
      }
      if (lead >= 0xb0) {
        letterRows++
        if (lead <= 0xc8) {
          hangulRows++
        }
      }
    }
    index += 2
  }
  return { characters, gb2312, eucShaped, letterRows, hangulRows, kanaRows }
}

/**
 * Whether the two-byte characters are Korean in EUC-KR: shaped as EUC-KR writes every character,
 * and with their letters inside its Hangul rows.
 */
function looksLikeEucKr(profile: TwoByteProfile): boolean {
  return (
    profile.characters > 0 &&
    profile.eucShaped / profile.characters >= MIN_EUC_SHAPED_SHARE &&
    profile.letterRows >= MIN_HANGUL_ROW_CHARACTERS &&
    profile.hangulRows / profile.letterRows >= MIN_HANGUL_ROW_SHARE
  )
}

/**
 * Of the characters in `text` past ASCII, the share `script` matches.
 *
 * Asked only of text decoded from bytes above ASCII, which every encoding here reads as characters
 * past it. Of text with none it would be NaN, which no threshold is met by — "not this script".
 */
function scriptShare(text: string, script: RegExp): number {
  let beyondAscii = 0
  let inScript = 0
  for (const character of text) {
    if (character.charCodeAt(0) < 0x80) {
      continue
    }
    beyondAscii++
    if (script.test(character)) {
      inScript++
    }
  }
  return inScript / beyondAscii
}

/**
 * Every byte as its Windows-1252 character. It can refuse nothing: every byte is one.
 *
 * Outside 0x80–0x9F a byte's Windows-1252 character is the one at its own code point, so the bytes
 * are read that way a chunk at a time and the range is mapped after.
 */
function decodeWindows1252(bytes: Uint8Array): string {
  const parts: Array<string> = []
  for (let start = 0; start < bytes.length; start += LATIN1_CHUNK) {
    parts.push(String.fromCharCode(...bytes.subarray(start, start + LATIN1_CHUNK)))
  }
  return parts
    .join("")
    .replace(/[\u0080-\u009f]/g, (character) => WINDOWS_1252_HIGH_RANGE.get(character.charCodeAt(0)) ?? character)
}

/**
 * Drop a leading UTF-8 byte-order mark. `TextDecoder` would for UTF-8, but the Windows-1252
 * fallback would not, and a file that lands there would begin with three stray characters.
 */
function stripUtf8Bom(bytes: Uint8Array): Uint8Array {
  const hasBom = bytes.length >= UTF8_BOM.length && UTF8_BOM.every((byte, index) => bytes[index] === byte)
  return hasBom ? bytes.subarray(UTF8_BOM.length) : bytes
}

/**
 * Cut a character the read stopped in the middle of.
 *
 * A UTF-8 character is a lead byte followed by `10xxxxxx` continuation bytes, so the last lead byte
 * is at most three bytes from the end. If fewer bytes follow it than it announces, the character is
 * incomplete and everything from it goes.
 */
function withoutPartialTrailingUtf8(bytes: Uint8Array): Uint8Array {
  for (let back = 1; back <= MAX_UTF8_BYTES_PER_CHAR && back <= bytes.length; back++) {
    const index = bytes.length - back
    const byte = bytes[index]
    if ((byte & 0b1100_0000) === 0b1000_0000) {
      // A continuation byte: the lead is further back.
      continue
    }
    return back >= utf8SequenceLength(byte) ? bytes : bytes.subarray(0, index)
  }
  return bytes
}

/** How many bytes the character starting with `lead` occupies. 1 for anything invalid. */
function utf8SequenceLength(lead: number): number {
  if ((lead & 0b1111_1000) === 0b1111_0000) {
    return 4
  }
  if ((lead & 0b1111_0000) === 0b1110_0000) {
    return 3
  }
  if ((lead & 0b1110_0000) === 0b1100_0000) {
    return 2
  }
  return 1
}

/** Which UTF-16 a byte-order mark says the file is, named as `TextDecoder` names it. */
export type Utf16ByteOrder = "utf-16le" | "utf-16be"

const HIGH_SURROGATE_FIRST = 0xd800
const HIGH_SURROGATE_LAST = 0xdbff

/**
 * Which UTF-16 the bytes are, by their byte-order mark, or undefined when they carry none.
 *
 * ⚠ `FF FE 00 00` is UTF-32's little-endian mark, not UTF-16's followed by a NUL, and is not
 * UTF-16. Nothing a teacher has writes UTF-32, so it is left to the byte-level rules, which
 * refuse it for its zero bytes.
 */
export function utf16ByteOrder(bytes: Uint8Array): Utf16ByteOrder | undefined {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return bytes[2] === 0x00 && bytes[3] === 0x00 ? undefined : "utf-16le"
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return "utf-16be"
  }
  return undefined
}

/**
 * The text of UTF-16 bytes that begin with their byte-order mark, without the mark.
 *
 * `truncated` says these are only the first of the file's bytes, which licenses dropping what the
 * read stopped in the middle of: an odd last byte, and a high surrogate whose pair it cut off.
 * Doing that unconditionally would drop the end of a whole file that is itself malformed.
 *
 * `fatal` makes a malformed sequence — a surrogate with no pair — throw rather than decode as
 * U+FFFD. The container check wants that: a file that is not well-formed UTF-16 is not UTF-16
 * text. A reader does not: one bad pair in a long file should cost one character, not the file.
 */
export function decodeUtf16Text(
  bytes: Uint8Array,
  byteOrder: Utf16ByteOrder,
  options: { truncated: boolean; fatal: boolean },
): string {
  let body = bytes.subarray(2)
  if (options.truncated) {
    body = body.subarray(0, body.length - (body.length % 2))
    const last = body.length >= 2 ? codeUnitAt(body, body.length - 2, byteOrder) : undefined
    if (last !== undefined && last >= HIGH_SURROGATE_FIRST && last <= HIGH_SURROGATE_LAST) {
      body = body.subarray(0, body.length - 2)
    }
  }
  // `ignoreBOM`: the mark was sliced off above, so a second one at the start is the file's own
  // character (a zero-width no-break space) and is kept as written.
  return new TextDecoder(byteOrder, { fatal: options.fatal, ignoreBOM: true }).decode(body)
}

function codeUnitAt(bytes: Uint8Array, index: number, byteOrder: Utf16ByteOrder): number {
  return new DataView(bytes.buffer, bytes.byteOffset + index, 2).getUint16(0, byteOrder === "utf-16le")
}
