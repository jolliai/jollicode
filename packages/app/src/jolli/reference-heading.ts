/**
 * Finds the heading a citation's heading path points at, in a rendered markdown body.
 *
 * `MarkdownContent` gives headings no ids, so the match is on their text. The path is the document's
 * own headings from the outermost in, so the target is the first heading matching its LAST segment
 * that comes after headings matching the earlier segments, in document order.
 *
 * The earlier segments are context, not a condition: when they cannot be found — the engine read a
 * heading slightly differently, or the file was edited since — the first heading matching the last
 * segment anywhere is still a better place to land than the top. When nothing matches, there is no
 * target and the reader stays at the top; a citation it cannot place is never an error.
 */
export function findCitedHeading(root: ParentNode, path: ReadonlyArray<string>): HTMLElement | undefined {
  const wanted = path.map(normalizeHeading).filter((segment) => segment !== "")
  if (wanted.length === 0) {
    return undefined
  }
  const last = wanted[wanted.length - 1]
  const headings = Array.from(root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6"))
  let matched = 0
  for (const heading of headings) {
    const text = normalizeHeading(heading.textContent ?? "")
    if (matched === wanted.length - 1 && text === last) {
      return heading
    }
    if (matched < wanted.length - 1 && text === wanted[matched]) {
      matched += 1
    }
  }
  return headings.find((heading) => normalizeHeading(heading.textContent ?? "") === last)
}

/** Heading text as compared: whitespace collapsed, case folded. */
function normalizeHeading(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase()
}
