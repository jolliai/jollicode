import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { MAX_STEPS_PROMPT } from "@opencode-ai/core/session/runner/max-steps"
import { TypedText } from "./typed-text"

/**
 * WHAT THE STUDENT WROTE, AS THE JOLLI GATEWAY IS TOLD IT.
 *
 * The gateway checks a request for personal data before it goes to the model, and only the student's own
 * words are searched; a file the client read into the message, a tool's output or the model's reply is
 * not. On the wire those are all text blocks, so the client says which blocks are the student's: the
 * request's `x-jolli-input-text` header carries the SHA-256 of each, never the text.
 *
 * ⚠ ONLY WHAT NO REQUEST HAS CARRIED YET IS DECLARED: everything after the model's last turn. An earlier
 * turn's words were checked when that turn ran, and the gateway rewrites them from what it found then;
 * declaring them again would only make it search them again. A tool call this program records in the
 * student's name — a command they ran from the composer, a subtask they started — is no turn of the model's,
 * and nor is the reply the step budget prefills with its closing note, or one a provider transform writes.
 *
 * ⚠ A BLOCK IS THE STUDENT'S WHEN THE SERVER SAYS SO, NEVER WHEN THE CLIENT DOES. Whoever sent a prompt
 * could set `synthetic` or this module's metadata key, and the app sends a student's own comment on a file
 * as `synthetic`. So every text part a prompt brings in is stamped on admission (`SessionPrompt`), and
 * whatever the prompt carried under the key is replaced: the whole block is the student's unless the agent
 * wrote the prompt. A part a client rewrites later keeps the server's stamp (`keepStamps`). A slash
 * command's block is the command file's text with the arguments spliced in, so its stamp carries the
 * ranges the arguments landed in (see `CommandTemplate`), and only those are the student's. A part the
 * server writes itself — a file it read, a summary — is never stamped.
 *
 * ⚠ A STUDENT ALSO TYPES INTO TOOL CALLS AND RESULTS: a command they run from the composer and a subtask
 * they start are recorded as tool calls, whose arguments are theirs; a question's answers, and the feedback
 * they give when they turn a call down, are tool results. Each is stamped under its tool part's state
 * metadata — the arguments by name under {@link CALL_METADATA_KEY}, a result under {@link METADATA_KEY} — with
 * the ranges the student's words landed in, and declared like a user's block. Any other tool call or output
 * is not.
 *
 * ⚠ A CALL RECORDED IN THE STUDENT'S NAME IS MARKED AS SUCH, APART FROM ITS STAMPS. It is no turn of the
 * model's, which moves where "after the model's last turn" begins; a model's call whose argument a client
 * rewrote has a stamped argument too, and is still the model's turn. So only the server marks a call as
 * recorded ({@link RECORDED_METADATA_KEY}), when it records one.
 *
 * ⚠ THE STAMPS LIVE IN METADATA A CLIENT CAN WRITE, so every path that writes a part has to keep them the
 * server's: admission (`SessionPrompt`), the part route (`keepStamps`), and replay, which never sends them as
 * provider options (`MessageV2`). A path that stores parts as they come keeps whatever they carry —
 * `opencode import` does, and so does a workspace's sync replay of another instance's events. What they
 * carry is what a server of this program stamped as the parts were made, unless someone edited it on the
 * way: an exported part edited to a stamp with no ranges declares nothing of a message the import leaves
 * unanswered. That is the student's own client misreporting the student's own words, which
 * the gateway could not tell from the truth by any field; and the gateway detects in the whole history of a
 * session its scope has not seen before, an imported one included. A field of the part's own that no
 * client could write would end the special cases, at the price of the stored part schema and the generated
 * SDKs. Until then, a new way of writing a part has to keep the server's stamps as these do.
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
export type Stamp = { readonly length: number; readonly ranges?: ReadonlyArray<TypedText.Range> }

/** How a text the server stamped goes to the model: the student's whole, or in its ranges. */
type Declaration = { readonly input: true; readonly ranges?: Array<[number, number]> }

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
    const stamp = role !== "user" ? undefined : unchanged ? storedStamp(stored.metadata) : { length: part.text.length }
    return { ...part, metadata: stamped(part.metadata, stamp) } as T
  }
  if (part.type !== "tool" || part.state.status === "pending") return part
  const before = stored?.type === "tool" && stored.state.status !== "pending" ? stored.state : undefined
  const text = resultText(part.state)
  const result =
    text === undefined
      ? undefined
      : before && resultText(before) === text
        ? storedStamp(before.metadata)
        : { length: text.length }
  const calls = Object.entries(part.state.input).flatMap(([name, value]) => {
    if (typeof value !== "string") return []
    const stamp = before?.input[name] === value ? storedCallStamps(before.metadata)[name] : { length: value.length }
    return stamp ? [[name, stamp] as const] : []
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
  const calls = Object.entries(storedCallStamps(metadata)).flatMap(([name, stamp]) => {
    const value = part.state.input[name]
    const argument = typeof value === "string" ? declaration(value, stamp) : undefined
    return argument ? [[name, argument.ranges ? { ranges: argument.ranges } : {}] as const] : []
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
  return { input: true, ranges: ranges.map(([start, end]): [number, number] => [start, end]) }
}

/**
 * The `[start, end)` ranges of `text` the student wrote, by the stamp the server recorded in `metadata`:
 * none for a text it did not stamp.
 */
export function spans(text: string, metadata: Record<string, unknown> | undefined): Array<[number, number]> {
  const declared = marker(text, metadata)
  if (!declared) return []
  return declared.ranges ?? [[0, text.length]]
}

/** The ranges of an argument of a tool part the student wrote, by the stamp the server recorded for it. */
export function callSpans(part: SessionV1.ToolPart, name: string): Array<[number, number]> {
  const value = part.state.input[name]
  if (typeof value !== "string" || part.state.status === "pending") return []
  const declared = declaration(value, storedCallStamps(part.state.metadata)[name])
  if (!declared) return []
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
  const entries = turn
    .slice(
      turn.findLastIndex(
        (message) => message.role === "assistant" && !recordedCall(message) && !filler(message.providerOptions),
      ) + 1,
    )
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .flatMap((part) => declaredBlocks(part))
    .flatMap(({ text, ranges }) => {
      const hash = new Bun.CryptoHasher("sha256").update(text).digest("hex")
      if (!Array.isArray(ranges)) return [hash]
      const valid = ranges.filter(isRange)
      // Ranges nothing here could have recorded: the whole block, rather than none of it.
      if (valid.length < ranges.length) return [hash]
      // A command with no arguments: nothing in its block is the student's.
      return valid.length === 0 ? [] : [[hash, ...valid.map(([start, end]) => `${start}-${end}`)].join(";")]
    })
  return entries.length === 0 ? NONE : entries.join(",")
}

/**
 * Ranges are kept only while they still describe the text: a plugin that rewrote it leaves them pointing
 * nowhere, and ranges out of order or past the end are not ones the server recorded. Either way the whole
 * block is declared instead.
 */
function declaration(text: string, stamp: Stamp | undefined): Declaration | undefined {
  if (stamp === undefined) return undefined
  if (stamp.length !== text.length || stamp.ranges === undefined) return { input: true }
  const ranges = stamp.ranges
  const ordered = ranges.every((range, index) => index === 0 || (ranges[index - 1]?.[1] ?? 0) <= range[0])
  if (!ordered || (ranges.at(-1)?.[1] ?? 0) > text.length) return { input: true }
  return { input: true, ranges: ranges.map(([start, end]) => [start, end]) }
}

/** The step budget's closing note, which prefills the reply rather than ending the turn before it. */
function prefills(message: { readonly role: string; readonly content: unknown } | undefined) {
  if (message?.role !== "assistant") return false
  if (typeof message.content === "string") return message.content === MAX_STEPS_PROMPT
  return (
    Array.isArray(message.content) &&
    message.content.length === 1 &&
    isRecord(message.content[0]) &&
    message.content[0].text === MAX_STEPS_PROMPT
  )
}

/** Whether a model message's provider options mark it as {@link FILLER_OPTIONS}. */
function filler(providerOptions: unknown) {
  const options = isRecord(providerOptions) ? providerOptions[OPTIONS_KEY] : undefined
  return isRecord(options) && options.filler === true
}

/** Whether a model message is a tool call this program recorded in the student's name. */
function recordedCall(message: { readonly content: unknown }) {
  return (
    Array.isArray(message.content) &&
    message.content.length > 0 &&
    message.content.every((part) => isRecord(part) && part.type === "tool-call" && declared(part)?.recorded === true)
  )
}

/** The blocks of a model message part the server stamped as the student's, with the ranges it declares. */
function declaredBlocks(part: unknown): Array<{ readonly text: string; readonly ranges: unknown }> {
  if (!isRecord(part)) return []
  const options = declared(part)
  if (part.type === "tool-call") {
    const input = part.input
    return isRecord(options?.call) && isRecord(input)
      ? Object.entries(options.call).flatMap(([name, argument]) => {
          const value = input[name]
          return typeof value === "string" && isRecord(argument) ? [{ text: value, ranges: argument.ranges }] : []
        })
      : []
  }
  const text = declarableText(part)
  return text !== undefined && options?.input === true ? [{ text, ranges: options.ranges }] : []
}

function declared(part: Record<string, unknown>) {
  const options = isRecord(part.providerOptions) ? part.providerOptions[OPTIONS_KEY] : undefined
  return isRecord(options) ? options : undefined
}

/** The text of a user text part or of a tool result's text output, the shapes the gateway reads them in. */
function declarableText(part: Record<string, unknown>) {
  if (part.type === "text") return typeof part.text === "string" ? part.text : undefined
  if (part.type !== "tool-result" || !isRecord(part.output)) return undefined
  const output = part.output
  return (output.type === "text" || output.type === "error-text") && typeof output.value === "string"
    ? output.value
    : undefined
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
 * dropped, leaving the whole text the student's rather than part of it.
 */
function readStamp(stamp: unknown): Stamp | undefined {
  if (!isRecord(stamp) || typeof stamp.length !== "number") return undefined
  if (!Array.isArray(stamp.ranges)) return { length: stamp.length }
  const ranges = stamp.ranges.filter(isRange)
  return ranges.length === stamp.ranges.length ? { length: stamp.length, ranges } : { length: stamp.length }
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
