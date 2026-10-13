import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { MAX_STEPS_PROMPT } from "@opencode-ai/core/session/runner/max-steps"
import { TypedText } from "./typed-text"

/**
 * User-input provenance for the Jolli gateway. Only stamped user text and string values written by
 * the user inside tool calls or results may be declared; other messages and object keys are excluded.
 * A stamp records a content fingerprint and optional UTF-16 ranges. Changed or malformed provenance
 * is skipped, never expanded into a template or converted into a rejected request.
 *
 * New input follows the model's last real turn. PATCH edits carry a revised marker so their exact
 * parts are also declared when stored earlier in history. No inference over unrelated history is needed.
 * The marker stays local metadata and is excluded from ordinary provider options.
 */

/** The metadata key — a text part's, or a tool part state's — the server stamps the student's text under. */
export const METADATA_KEY = "jolliInput"

/** The metadata key of a tool part's state the server stamps the arguments the student wrote under, by name. */
export const CALL_METADATA_KEY = "jolliInputCall"

/** The metadata key of a tool part's state the server marks a call it recorded in the student's name with. */
export const RECORDED_METADATA_KEY = "jolliRecordedCall"

/** The provider-options namespace a model message part carries the declaration in. */
export const OPTIONS_KEY = "jolliPii"

/**
 * The provider options of a message this program writes into a prompt for a provider's sake alone — the
 * reply some models need between a tool result and the user's next message. It is no turn of the model's,
 * so what the student wrote before it is still what no request has carried yet.
 */
export const FILLER_OPTIONS = { [OPTIONS_KEY]: { filler: true } }

export const HEADER = "x-jolli-input-text"

/** What the header says for a request carrying nothing the student wrote that no request has carried yet. */
const NONE = "none"

/** The whole of a text is the student's, or only the ranges their words landed in. */
export type Stamp = {
  readonly length: number
  readonly fingerprint?: string
  readonly ranges?: ReadonlyArray<TypedText.Range>
  readonly revised?: true
  readonly path?: ReadonlyArray<string | number>
}

/** How a text the server stamped goes to the model: the student's whole, or in its ranges. */
type Declaration = { readonly input: true; readonly ranges?: Array<[number, number]>; readonly revised?: true }

/** Bind provenance to the actual text, so equal-length edits cannot reuse stale ranges. */
export function stamp(text: string, ranges?: ReadonlyArray<TypedText.Range>, revised = false): Stamp {
  return {
    length: text.length,
    fingerprint: fingerprint(text),
    ...(ranges ? { ranges } : {}),
    ...(revised ? { revised: true } : {}),
  }
}

function fingerprint(text: string) {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex")
}

/**
 * Metadata with `stamp` recorded under {@link METADATA_KEY}, and anything a client put there gone. Undefined
 * stamps nothing: the text is not the student's.
 */
export function stamped(metadata: Record<string, unknown> | undefined, stamp: Stamp | undefined) {
  return recorded(metadata, METADATA_KEY, stamp)
}

/**
 * The state metadata of a call the server records in the student's name — a command they ran from the
 * composer, a subtask they started — with the stamps of the arguments they wrote, by name.
 */
export function studentCall(stamps: Readonly<Record<string, Stamp>>) {
  return { [CALL_METADATA_KEY]: stamps, [RECORDED_METADATA_KEY]: true }
}

/**
 * A part a client wrote back, with the server's stamps as they were stored and the client's own discarded.
 *
 * A text or an argument the client changed — or one the server never stored — is the client's own words,
 * so it is the student's whole; one it left as it was keeps whatever the server recorded, which may be
 * nothing. Only a user message's text is ever the student's: what the model replied stays the model's,
 * however a client edits it. A call is recorded in the student's name only where the server recorded it so:
 * an argument a client rewrote does not make the model's call theirs.
 *
 * @param role - the role of the message the part belongs to, or undefined when there is none.
 */
export function keepStamps<T extends SessionV1.Part>(
  part: T,
  stored: SessionV1.Part | undefined,
  role: SessionV1.Info["role"] | undefined,
): T {
  if (part.type === "text") {
    const unchanged = stored?.type === "text" && stored.text === part.text
    const next =
      role !== "user" ? undefined : unchanged ? storedStamp(stored.metadata) : stamp(part.text, undefined, true)
    return { ...part, metadata: stamped(part.metadata, next) } as T
  }
  if (part.type !== "tool" || part.state.status === "pending") return part
  const before = stored?.type === "tool" && stored.state.status !== "pending" ? stored.state : undefined
  const text = resultText(part.state)
  const result =
    text === undefined
      ? undefined
      : before && resultText(before) === text
        ? storedStamp(before.metadata)
        : stamp(text, undefined, true)
  const prior = storedCallStamps(before?.metadata)
  const calls = stringLeaves(part.state.input).flatMap(({ path, text }) => {
    const saved = callStamp(prior, path)
    const current = before && argumentAt(before.input, path) === text ? saved : stamp(text, undefined, true)
    if (!current) return []
    const key = path.length === 1 ? String(path[0]) : JSON.stringify(path)
    return [[key, { ...current, ...(path.length > 1 ? { path } : {}) }] as const]
  })
  const metadata = recorded(
    recorded(
      stamped(part.state.metadata, result),
      CALL_METADATA_KEY,
      calls.length > 0 ? Object.fromEntries(calls) : undefined,
    ),
    RECORDED_METADATA_KEY,
    before?.metadata?.[RECORDED_METADATA_KEY] === true ? true : undefined,
  )
  return { ...part, state: { ...part.state, metadata: metadata ?? {} } } as T
}

/**
 * The declaration a text carries into its model message, read off the metadata the server stamped it in,
 * or undefined for a text the server did not stamp as the student's.
 */
export function marker(text: string, metadata: Record<string, unknown> | undefined) {
  return declaration(text, storedStamp(metadata))
}

/**
 * The declaration a tool part carries into its model messages, or undefined when the student wrote none of
 * it: its result, when `result` is the text the result goes to the model as and the server stamped it, the
 * arguments the server stamped, by name, and whether the server recorded the call in the student's name.
 * The AI SDK sends a call's provider options with the call and with its result alike, which is the only way
 * either carries any.
 */
export function toolMarker(part: SessionV1.ToolPart, result: unknown) {
  const metadata = part.state.status === "pending" ? undefined : part.state.metadata
  const declared = typeof result === "string" ? sentResult(part.state, result) : undefined
  const calls = Object.entries(storedCallStamps(metadata)).flatMap(([name, saved]) => {
    const path = saved.path ?? [name]
    const value = argumentAt(part.state.input, path)
    const argument = typeof value === "string" ? declaration(value, saved) : undefined
    return argument
      ? [
          [
            name,
            {
              ...(argument.ranges ? { ranges: argument.ranges } : {}),
              ...(argument.revised ? { revised: true } : {}),
              ...(saved.path ? { path: [...path] } : {}),
            },
          ] as const,
        ]
      : []
  })
  const studentRecorded = metadata?.[RECORDED_METADATA_KEY] === true
  if (!declared && calls.length === 0 && !studentRecorded) return undefined
  return {
    ...declared,
    ...(calls.length > 0 ? { call: Object.fromEntries(calls) } : {}),
    ...(studentRecorded ? { recorded: true } : {}),
  }
}

/**
 * The declaration of a tool result the model is sent as `text`: the result as the server stored it, or that
 * result cut short, or cleared as old. The stamp's ranges hold only as far as `text` keeps the stored result
 * from its start, so a result cleared as old declares nothing — its placeholder is no one's words — and one
 * cut short declares what is left of them.
 */
function sentResult(state: SessionV1.ToolPart["state"], text: string): Declaration | undefined {
  const stored = resultText(state)
  const metadata = state.status === "pending" ? undefined : state.metadata
  if (stored === undefined || stored === text) return marker(text, metadata)
  const whole = marker(stored, metadata)
  if (!whole) return undefined
  const shared = Math.min(text.length, stored.length)
  const kept =
    Array.from({ length: shared }, (_, index) => index).find((index) => text[index] !== stored[index]) ?? shared
  const ranges = TypedText.slice({ text: stored, ranges: whole.ranges ?? [[0, stored.length]] }, 0, kept).ranges
  if (ranges.length === 0) return undefined
  return {
    input: true,
    ranges: ranges.map(([start, end]): [number, number] => [start, end]),
    ...(whole.revised ? { revised: true as const } : {}),
  }
}

/**
 * The `[start, end)` ranges of `text` the student wrote, by the stamp the server recorded in `metadata`:
 * none for a text it did not stamp.
 */
export function spans(
  text: string,
  metadata: Record<string, unknown> | undefined,
  revisedOnly = false,
): Array<[number, number]> {
  const declared = marker(text, metadata)
  if (!declared || (revisedOnly && !declared.revised)) return []
  return declared.ranges ?? [[0, text.length]]
}

/** The ranges of an argument of a tool part the student wrote, by the stamp the server recorded for it. */
export function callSpans(
  part: SessionV1.ToolPart,
  name: string | ReadonlyArray<string | number>,
  revisedOnly = false,
): Array<[number, number]> {
  const path = typeof name === "string" ? [name] : name
  const value = argumentAt(part.state.input, path)
  if (typeof value !== "string" || part.state.status === "pending") return []
  const declared = declaration(value, callStamp(storedCallStamps(part.state.metadata), path))
  if (!declared || (revisedOnly && !declared.revised)) return []
  return declared.ranges ?? [[0, value.length]]
}

/** The names of the arguments of a tool part the server stamped as the student's. */
export function stampedArguments(part: SessionV1.ToolPart) {
  return Object.keys(storedCallStamps(part.state.status === "pending" ? undefined : part.state.metadata))
}

/**
 * Whether a stored message is a tool call this program recorded in the student's name rather than a turn of
 * the model's: an assistant message whose every call the server marked as recorded, and nothing else.
 */
export function recordedForStudent(message: SessionV1.WithParts) {
  if (message.info.role !== "assistant") return false
  const content = message.parts.filter(
    (part) => part.type === "text" || part.type === "reasoning" || part.type === "tool",
  )
  return (
    content.length > 0 &&
    content.every(
      (part) =>
        part.type === "tool" &&
        part.state.status !== "pending" &&
        part.state.metadata?.[RECORDED_METADATA_KEY] === true,
    )
  )
}

/**
 * The `x-jolli-input-text` value for a prompt, read off what follows the model's last turn: one entry per
 * declared user text, tool result or tool call argument, `<sha256>` or `<sha256>;<start>-<end>;...`, joined
 * by commas.
 */
export function header(
  prompt: ReadonlyArray<{ readonly role: string; readonly content: unknown; readonly providerOptions?: unknown }>,
): string {
  const turn = prefills(prompt.at(-1)) ? prompt.slice(0, -1) : prompt
  const boundary = turn.findLastIndex(
    (message) => message.role === "assistant" && !recordedCall(message) && !filler(message.providerOptions),
  )
  // Edited historical parts are new user input even when they precede the last model turn.
  const entries = turn
    .flatMap((message, index) =>
      (Array.isArray(message.content) ? message.content : []).flatMap((part) =>
        declaredBlocks(part).filter((block) => index > boundary || block.revised),
      ),
    )
    .flatMap(({ text, ranges }) => {
      const hash = new Bun.CryptoHasher("sha256").update(text).digest("hex")
      if (ranges === undefined) return [hash]
      if (!Array.isArray(ranges)) return []
      const valid = ranges.filter(isRange)
      // Missing or invalid provenance skips detection; it never expands to the whole block.
      if (
        valid.length < ranges.length ||
        valid.some((range, index) => range[1] > text.length || (index > 0 && valid[index - 1][1] > range[0]))
      )
        return []
      // A command with no arguments: nothing in its block is the student's.
      return valid.length === 0 ? [] : [[hash, ...valid.map(([start, end]) => `${start}-${end}`)].join(";")]
    })
  return entries.length === 0 ? NONE : [...new Set(entries)].join(",")
}

/**
 * Ranges are kept only while their fingerprint matches the text and they remain ordered and in bounds.
 * Invalid or stale provenance declares nothing; the request continues without expanding detection.
 */
function declaration(text: string, stamp: Stamp | undefined): Declaration | undefined {
  if (stamp === undefined) return undefined
  // An invalid declaration is skipped. It never broadens to a template or refuses the request.
  if (stamp.length !== text.length || (stamp.fingerprint !== undefined && stamp.fingerprint !== fingerprint(text)))
    return undefined
  if (stamp.ranges !== undefined && stamp.fingerprint === undefined) return undefined
  const revised = stamp.revised ? { revised: true as const } : {}
  if (stamp.ranges === undefined) return { input: true, ...revised }
  const ranges = stamp.ranges
  const ordered = ranges.every((range, index) => index === 0 || (ranges[index - 1]?.[1] ?? 0) <= range[0])
  if (!ordered || (ranges.at(-1)?.[1] ?? 0) > text.length) return undefined
  return { input: true, ranges: ranges.map(([start, end]) => [start, end]), ...revised }
}

/** The step budget's closing note, which prefills the reply rather than ending the turn before it. */
function prefills(message: { readonly role: string; readonly content: unknown } | undefined) {
  if (message?.role !== "assistant") return false
  if (typeof message.content === "string") return message.content === MAX_STEPS_PROMPT
  const content = Array.isArray(message.content) ? message.content.filter((part) => !emptyReasoning(part)) : []
  return (
    content.length === 1 &&
    isRecord(content[0]) &&
    content[0].type === "text" &&
    content[0].text === MAX_STEPS_PROMPT
  )
}

/** Whether a model message's provider options mark it as {@link FILLER_OPTIONS}. */
function filler(providerOptions: unknown) {
  const options = isRecord(providerOptions) ? providerOptions[OPTIONS_KEY] : undefined
  return isRecord(options) && options.filler === true
}

/** Whether a model message is a tool call this program recorded in the student's name. */
function recordedCall(message: { readonly content: unknown }) {
  const content = Array.isArray(message.content) ? message.content.filter((part) => !emptyReasoning(part)) : []
  return (
    content.length > 0 &&
    content.every((part) => isRecord(part) && part.type === "tool-call" && declared(part)?.recorded === true)
  )
}

/** Provider-required empty reasoning does not turn a recorded call or a prefill into a model reply. */
function emptyReasoning(part: unknown) {
  return isRecord(part) && part.type === "reasoning" && part.text === ""
}

/** The blocks of a model message part the server stamped as the student's, with the ranges it declares. */
function declaredBlocks(
  part: unknown,
): Array<{ readonly text: string; readonly ranges: unknown; readonly revised: boolean }> {
  if (!isRecord(part)) return []
  const options = declared(part)
  if (part.type === "tool-call") {
    return isRecord(options?.call) && isRecord(part.input)
      ? Object.entries(options.call).flatMap(([name, argument]) => {
          if (!isRecord(argument)) return []
          const path = readPath(argument.path) ?? [name]
          const value = argumentAt(part.input, path)
          return typeof value === "string"
            ? [{ text: value, ranges: argument.ranges, revised: argument.revised === true }]
            : []
        })
      : []
  }
  return options?.input === true
    ? declarableTexts(part).map((text) => ({ text, ranges: options.ranges, revised: options.revised === true }))
    : []
}

function declared(part: Record<string, unknown>) {
  const options = isRecord(part.providerOptions) ? part.providerOptions[OPTIONS_KEY] : undefined
  return isRecord(options) ? options : undefined
}

/** The text of a user text part or of a tool result's text output, the shapes the gateway reads them in. */
function declarableTexts(part: Record<string, unknown>) {
  if (part.type === "text") return typeof part.text === "string" ? [part.text] : []
  if (part.type !== "tool-result" || !isRecord(part.output)) return []
  const output = part.output
  if ((output.type === "text" || output.type === "error-text") && typeof output.value === "string")
    return [output.value]
  if (output.type !== "content" || !Array.isArray(output.value)) return []
  return output.value.flatMap((entry) =>
    isRecord(entry) && entry.type === "text" && typeof entry.text === "string" ? [entry.text] : [],
  )
}

/** The text a tool part's state sends the model as its result: its output, or its error. */
function resultText(state: SessionV1.ToolPart["state"]) {
  if (state.status === "completed") return state.output
  if (state.status === "error") return state.error
  return undefined
}

/** Metadata with `value` recorded under `key`, or the key gone when it is undefined; undefined when empty. */
function recorded(metadata: Record<string, unknown> | undefined, key: string, value: unknown) {
  const rest = Object.fromEntries(Object.entries(metadata ?? {}).filter(([name]) => name !== key))
  if (value !== undefined) return { ...rest, [key]: value }
  return Object.keys(rest).length > 0 ? rest : undefined
}

/** The stamp metadata holds, or undefined for none. */
function storedStamp(metadata: Record<string, unknown> | undefined) {
  return readStamp(metadata?.[METADATA_KEY])
}

/** The stamps of a tool part's arguments metadata holds, by argument name. */
function storedCallStamps(metadata: Record<string, unknown> | undefined): Record<string, Stamp> {
  const stamps = metadata?.[CALL_METADATA_KEY]
  if (!isRecord(stamps)) return {}
  return Object.fromEntries(
    Object.entries(stamps).flatMap(([name, value]) => {
      const stamp = readStamp(value)
      return stamp ? [[name, stamp] as const] : []
    }),
  )
}

/**
 * A stamp, or undefined for what is none. Ranges that are not all ones the server could have recorded are
 * rejected rather than expanded to the whole text.
 */
function readStamp(stamp: unknown): Stamp | undefined {
  if (!isRecord(stamp) || typeof stamp.length !== "number") return undefined
  if (stamp.ranges !== undefined && !Array.isArray(stamp.ranges)) return undefined
  if (stamp.fingerprint !== undefined && typeof stamp.fingerprint !== "string") return undefined
  if (stamp.path !== undefined && !readPath(stamp.path)) return undefined
  const ranges = Array.isArray(stamp.ranges) ? stamp.ranges.filter(isRange) : undefined
  if (Array.isArray(stamp.ranges) && ranges?.length !== stamp.ranges.length) return undefined
  return {
    length: stamp.length,
    ...(typeof stamp.fingerprint === "string" ? { fingerprint: stamp.fingerprint } : {}),
    ...(ranges ? { ranges } : {}),
    ...(stamp.revised === true ? { revised: true as const } : {}),
    ...(readPath(stamp.path) ? { path: readPath(stamp.path) } : {}),
  }
}

function readPath(path: unknown): ReadonlyArray<string | number> | undefined {
  return Array.isArray(path) &&
    path.every(
      (piece) => typeof piece === "string" || (typeof piece === "number" && Number.isInteger(piece) && piece >= 0),
    )
    ? path
    : undefined
}

function argumentAt(input: unknown, path: ReadonlyArray<string | number>): unknown {
  return path.reduce<unknown>((value, piece) => {
    if (Array.isArray(value)) return Object.hasOwn(value, piece) ? value[Number(piece)] : undefined
    return isRecord(value) && Object.hasOwn(value, piece) ? value[String(piece)] : undefined
  }, input)
}

function callStamp(stamps: Record<string, Stamp>, path: ReadonlyArray<string | number>) {
  return Object.entries(stamps).find(
    ([name, saved]) => JSON.stringify(saved.path ?? [name]) === JSON.stringify(path),
  )?.[1]
}

function stringLeaves(
  input: unknown,
  path: ReadonlyArray<string | number> = [],
): Array<{ path: ReadonlyArray<string | number>; text: string }> {
  if (typeof input === "string") return [{ path, text: input }]
  if (Array.isArray(input)) return input.flatMap((value, index) => stringLeaves(value, [...path, index]))
  if (isRecord(input)) return Object.entries(input).flatMap(([key, value]) => stringLeaves(value, [...path, key]))
  return []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isRange(value: unknown): value is TypedText.Range {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    Number.isInteger(value[0]) &&
    Number.isInteger(value[1]) &&
    value[0] >= 0 &&
    value[0] < value[1]
  )
}

export * as JolliInput from "./jolli-input"
