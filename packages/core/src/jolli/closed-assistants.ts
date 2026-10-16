/**
 * ASSISTANTS THE GATEWAY REFUSED AS CLOSED, SERVED AS CLOSED WHATEVER THE READER'S CLOCK SAYS.
 *
 * ⚠ A CLOCK BEHIND THE GATEWAY'S KEEPS OFFERING A CLOSED ASSISTANT, AND A REFRESH CANNOT FIX IT. Both
 * renderers judge a window with `Lookup.windowPhase` against their own clock, so on a machine running
 * late an assistant past its `endsAt` still reads as open. The chat is refused, the catalogue is asked
 * for again, the same `endsAt` comes back, and the same clock offers the same assistant — every time.
 *
 * ⚠ SO THE REFUSAL IS TAKEN AS THE FACT. The `endsAt` served for the assistant becomes the epoch,
 * which no clock reads as ahead, so every reader closes it without being told why — including one on
 * another machine whose clock trails this one. Its `startsAt` goes too: `windowPhase` reads a start
 * first, and a clock that trails it would answer "not open yet", which lets an existing chat go on.
 * Nothing reads either but that judgement.
 *
 * ⚠ UNTIL THE TEACHER MOVES THE WINDOW. The `endsAt` the catalogue held is pinned the first time the
 * assistant is served after the refusal. A later one, or none at all, is a window that was reopened
 * and drops the record; an earlier one is the same closure, only stated more tightly.
 *
 * ⚠ PROCESS MEMORY, FORGOTTEN AT SIGN-IN AND SIGN-OUT. A restart costs at most one more refused chat.
 *
 * ⚠ A FIX FOR ONE SYMPTOM OF CLOCK SKEW, NOT FOR SKEW, AND KNOWINGLY SO. A clock ahead of the
 * gateway's still offers an assistant before it opens (`assistant_not_open`), and every other window
 * judgement still reads the local clock. The cure for all of them is an offset learned from the
 * gateway — its `Date` header, or a `now` served with the catalogue — applied wherever `windowNow`
 * and `windowPhase` read the time, in both renderers. That touches every window judgement and the
 * catalogue's wire shape, so it is its own change; this one stops the loop that was actually hit,
 * a closed assistant offered and refused on every new chat.
 */
export * as JolliClosedAssistants from "./closed-assistants"

import type { Jolli } from "@opencode-ai/schema/jolli"

const CLOSED = new Date(0).toISOString()

/** Assistant id → the `endsAt` the catalogue held for it, once it has been served since the refusal. */
const refused = new Map<string, { endsAt?: string | null }>()

/** The gateway refused a chat with this assistant because its window has closed. */
export function record(assistantId: string) {
  refused.set(assistantId, {})
}

/** Forget every refusal — the student they were made for has signed out. */
export function reset() {
  refused.clear()
}

/** `catalog`, with every assistant the gateway refused as closed served as closed. */
export function apply(catalog: Jolli.Catalog): Jolli.Catalog {
  if (refused.size === 0) return catalog
  return { ...catalog, assistants: catalog.assistants.map(closed) }
}

function closed(assistant: Jolli.Assistant): Jolli.Assistant {
  const entry = refused.get(assistant.id)
  if (!entry) return assistant
  const endsAt = assistant.endsAt ?? null
  if (entry.endsAt !== undefined && moved(entry.endsAt, endsAt)) {
    refused.delete(assistant.id)
    return assistant
  }
  refused.set(assistant.id, { endsAt })
  return { ...assistant, startsAt: null, endsAt: CLOSED }
}

/**
 * Whether `next` is a window the teacher reopened since `pinned`: a later end, or none at all.
 *
 * ⚠ AN END WHERE THE PINNED SNAPSHOT HAD NONE IS NOT A REOPENING. The gateway refuses as closed only
 * past `endsAt`, so a pinned `null` was a snapshot older than the window that closed it, and the end
 * that arrives next is that window.
 */
function moved(pinned: string | null, next: string | null) {
  if (next === null) return pinned !== null
  if (pinned === null) return false
  return Date.parse(next) > Date.parse(pinned)
}
