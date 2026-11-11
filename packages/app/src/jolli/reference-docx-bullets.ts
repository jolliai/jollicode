/**
 * Word's bullets, as characters a browser can draw.
 *
 * Word writes a bulleted list's bullet into `word/numbering.xml` as a private-use character in the
 * `Symbol` or `Wingdings` font — `U+F0B7` for •, `U+F0A7` for ▪ — which only those fonts draw. A
 * browser without them draws a box at the start of every item.
 */

/** The private-use bullets Word writes most, and what each looks like in its font. */
const SYMBOL_BULLETS: ReadonlyMap<number, string> = new Map([
  [0xf0b7, "•"],
  [0xf0a7, "▪"],
  [0xf0d8, "➢"],
  [0xf0fc, "✓"],
])

/** Any other private-use bullet: a plain bullet is closer than a box. */
const FALLBACK_BULLET = "•"

const PRIVATE_USE_FIRST = 0xe000
const PRIVATE_USE_LAST = 0xf8ff

/** Each `w:lvlText` value, the one attribute where a list level's bullet or number format lives. */
const LEVEL_TEXT = /(<w:lvlText\b[^>]*\bw:val=")([^"]*)(")/g

/** A private-use character written literally or as a numeric character reference. */
const CHARACTER = /&#x([0-9a-fA-F]+);|&#(\d+);|[-]/g

/**
 * `numbering.xml` with every private-use bullet in a list level's text replaced by its Unicode
 * equivalent. Numbered levels (`%1.`) and ordinary characters are left alone.
 */
export function mapSymbolBullets(numberingXml: string): string {
  return numberingXml.replace(
    LEVEL_TEXT,
    (_match, before: string, value: string, after: string) =>
      `${before}${value.replace(CHARACTER, mapCharacter)}${after}`,
  )
}

function mapCharacter(match: string, hex: string | undefined, decimal: string | undefined): string {
  const code =
    hex !== undefined
      ? Number.parseInt(hex, 16)
      : decimal !== undefined
        ? Number.parseInt(decimal, 10)
        : match.charCodeAt(0)
  if (code < PRIVATE_USE_FIRST || code > PRIVATE_USE_LAST) {
    return match
  }
  return SYMBOL_BULLETS.get(code) ?? FALLBACK_BULLET
}
