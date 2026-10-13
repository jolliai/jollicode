/**
 * TEXT, WITH THE RANGES OF IT THE STUDENT TYPED, CARRIED THROUGH EVERY EDIT OF IT.
 *
 * The Jolli gateway checks only the student's own words for personal data, so text this program builds
 * around them — a slash command's template with its arguments spliced in, a question's answers laid out
 * beside the model's questions, a compaction's quote of the history — says which `[start, end)` UTF-16
 * ranges of it are theirs (`JolliInput`). Every edit is made here, so how a range moves at a join, or
 * where a replacement cuts it, is decided once for every text built this way.
 */

/** A `[start, end)` UTF-16 range of a text. */
export type Range = readonly [number, number]

/** A text, with the ranges of it the student typed, in order and disjoint. */
export type Info = { readonly text: string; readonly ranges: ReadonlyArray<Range> }

/** A text the student typed whole. */
export function typed(text: string): Info {
  return { text, ranges: text ? [[0, text.length]] : [] }
}

/**
 * `pieces` joined by `separator`, empty ones left out, each one's ranges moved to where it lands. A string
 * is no one's typing.
 */
export function join(pieces: ReadonlyArray<string | Info>, separator = ""): Info {
  return pieces
    .map((piece) => (typeof piece === "string" ? { text: piece, ranges: [] } : piece))
    .filter((piece) => piece.text)
    .reduce<Info>(
      (joined, piece) => {
        const at = joined.text ? joined.text.length + separator.length : 0
        return {
          text: joined.text ? joined.text + separator + piece.text : piece.text,
          ranges: [...joined.ranges, ...piece.ranges.map(([start, end]) => [start + at, end + at] as const)],
        }
      },
      { text: "", ranges: [] },
    )
}

/** `source.text[start, end)`, with the ranges kept to what it holds. */
export function slice(source: Info, start: number, end = source.text.length): Info {
  return {
    text: source.text.slice(start, end),
    ranges: source.ranges.flatMap(([from, to]) => {
      const kept = [Math.max(from, start) - start, Math.min(to, end) - start] as const
      return kept[0] < kept[1] ? [kept] : []
    }),
  }
}

/** Surrounding whitespace trimmed, the ranges kept on the text they covered. */
export function trim(source: Info): Info {
  const start = source.text.length - source.text.trimStart().length
  return slice(source, start, start + source.text.trim().length)
}

/**
 * `source.text[start, end)` replaced by `replacement`. Ranges after the span shift with it; a range the span
 * cuts keeps what lies outside it.
 */
export function splice(source: Info, start: number, end: number, replacement: string | Info): Info {
  return join([slice(source, 0, start), replacement, slice(source, end)])
}

export * as TypedText from "./typed-text"
