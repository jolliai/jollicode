/**
 * READING THE ONE JSON OBJECT A SHORT MODEL CALL WAS ASKED TO WRITE AS TEXT.
 *
 * Used by the course turn's source selection (`JolliSources.select`), whose reply is JSON rather
 * than a tool call: a tool call would hand the object over already separated from prose, but a call
 * that keeps the student's own model and reasoning setting cannot force one on every provider, so
 * the object is read out of the text instead.
 *
 * ⚠ THE COURSE INTENT CLASSIFICATION THAT ONCE SHARED THIS IS GONE FROM THIS PROCESS. A course
 * session's turns are decided by the Jolli gateway now, on the server, so the selection is the only
 * reader here. The quote repair is kept for it: the failure it was ported for — a model quoting words
 * with plain double quotes — breaks a selection reply just the same.
 */
export * as JolliReplyJson from "./reply-json"

import { Option, Schema } from "effect"

const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)

const OPEN_REASONING = "<think>"
const CLOSE_REASONING = "</think>"

/**
 * The reply without the reasoning a model wrote inline, as R1- and QwQ-style models do over an
 * OpenAI-compatible endpoint. Reasoning a provider reports as reasoning never reaches the reply text.
 *
 * Three shapes are dropped: a closed `<think>…</think>` block; everything up to a closing tag that
 * has no opening one, because a chat template that opens the block itself sends only its end; and an
 * opening tag still waiting for its end, because that is reasoning still being written.
 */
export function withoutInlineReasoning(text: string) {
  const closed = text.replace(/<think>[\s\S]*?<\/think>/g, "")
  const orphan = closed.lastIndexOf(CLOSE_REASONING)
  const after = orphan === -1 ? closed : closed.slice(orphan + CLOSE_REASONING.length)
  const open = after.indexOf(OPEN_REASONING)
  return open === -1 ? after : after.slice(0, open)
}

/**
 * The reply's first JSON object, parsed — repaired once when stray quotes broke it.
 *
 * Reasoning a model writes inline is dropped first ({@link withoutInlineReasoning}), because braces
 * inside it would otherwise be taken for the object. The repair runs only after the strict parse
 * failed, so a reply that was already valid is read exactly as written.
 */
export function parseObject(
  text: string,
): { readonly kind: "ok"; readonly value: unknown } | { readonly kind: "missing" } | { readonly kind: "invalid" } {
  const reply = withoutInlineReasoning(text)
  const json = extractObject(reply)
  if (json === undefined) return { kind: "missing" }
  const strict = decodeJson(json)
  if (Option.isSome(strict)) return { kind: "ok", value: strict.value }
  const start = reply.indexOf("{")
  const repaired = extractObject(escapeStrayQuotes(reply.slice(start)))
  const second = repaired === undefined ? Option.none() : decodeJson(repaired)
  return Option.isSome(second) ? { kind: "ok", value: second.value } : { kind: "invalid" }
}

/** The first balanced JSON object in a reply, ignoring braces inside strings, or undefined. */
export function extractObject(text: string) {
  const start = text.indexOf("{")
  if (start === -1) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index++) {
    const char = text[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (inString) {
      escaped = char === "\\"
      inString = char !== '"'
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === "{") depth++
    if (char === "}" && --depth === 0) return text.slice(start, index + 1)
  }
  return undefined
}

/**
 * The reply with every double quote that sits INSIDE a string value escaped.
 *
 * ⚠ PORTED FROM JOLLIEDU'S `CourseSearchKeywords`, WHERE IT WAS OBSERVED: a model quoting the
 * student's own words with plain double quotes stops the object being JSON two words in, with
 * nothing else wrong with it. A quote inside a string closes it only when what follows, past any
 * whitespace, is a structural character (`,` `}` `]` `:`) or the end of the text; any other quote
 * there is content and is escaped. A well-formed object comes back byte-identical.
 */
function escapeStrayQuotes(text: string) {
  let repaired = ""
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (!inString) {
      inString = char === '"'
      repaired += char
      continue
    }
    if (escaped) {
      escaped = false
      repaired += char
      continue
    }
    escaped = char === "\\"
    if (char === '"') {
      let ahead = index + 1
      while (ahead < text.length && /\s/u.test(text[ahead] ?? "")) ahead++
      const next = text[ahead]
      inString = next !== undefined && !",}]:".includes(next)
      if (inString) repaired += "\\"
    }
    repaired += char
  }
  return repaired
}
