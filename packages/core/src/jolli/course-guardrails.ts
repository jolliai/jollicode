/**
 * THE SWITCHES OF THE ASSISTANT A SESSION IS BOUND TO, AS THE STUDENT'S CATALOGUE STATES THEM.
 *
 * ⚠ FOR WHAT THIS PROCESS DRAWS OR ACCEPTS, NEVER FOR WHAT THE MODEL IS TOLD. The gateway applies the
 * course to every model request of a bound session — the assistant's briefing, its guardrails, the
 * per-turn rule — on the server, so nothing here shapes a prompt or withholds a tool. What this
 * answers is whether the student is shown something beside the answer, such as the sources it rests
 * on, and whether a session may be bound to the assistant without Start.
 *
 * ⚠ THE CATALOGUE MAY BE MINUTES BEHIND THE GATEWAY. It is a cached snapshot, so a teacher's edit can
 * reach the model a few minutes before it reaches what this process draws.
 */
export * as JolliCourseGuardrails from "./course-guardrails"

import { Duration, Effect } from "effect"
import { gatewayRequest, type GatewayRequest } from "./api"
import type { CourseBinding } from "./binding"
import { loadCatalog, readCatalog, type CatalogSnapshot } from "./cache"
import { projectCatalog, today } from "./catalog"
import { Lookup } from "./lookup"
import { JolliSession } from "./session"

/**
 * How long a read waits for the catalogue, and for the credential it is read with, before it gives
 * up and answers that it does not know.
 */
const TIMEOUT = Duration.seconds(5)

/**
 * The switches of the assistant `binding` names, read with the credential this process holds, or
 * undefined when the credential or the catalogue cannot say. It never fails.
 *
 * The one reading every caller in this process makes, so whether a course shows its sources is
 * decided the same way when its evidence is recorded and when its answer is judged.
 */
export const ofBinding = Effect.fn("JolliCourseGuardrails.ofBinding")(function* (binding: CourseBinding) {
  const jolli = yield* JolliSession.Service
  const request = yield* jolli.request().pipe(
    Effect.timeout(TIMEOUT),
    Effect.catchCause(() => Effect.succeed(undefined)),
  )
  return (yield* lookup({ request, binding }))?.guardrails
})

/**
 * Whether the assistant `binding` names speaks first, so a chat with it is made by Start; undefined
 * when the credential or the catalogue on disk cannot say. It never fails.
 *
 * ⚠ THE SNAPSHOT ON DISK, HOWEVER OLD, NEVER A REFRESH. This sits in front of creating the session a
 * student's first message goes into; a catalogue past its TTL would otherwise hold that up on a
 * gateway round trip — the whole timeout when offline. The renderer offered the assistant from this
 * same snapshot, so it is the one to judge the binding by.
 *
 * ⚠ AND THE STORED CREDENTIAL, NEVER A FRESH TOKEN. `request()` renews a token near its expiry, which
 * is a round trip to the auth hub; the snapshot is filed by tenant and identity, never by token, so
 * finding it needs only the row as it stands. *
 * ⚠ READ AND PROJECTED WHOLE ON EVERY CALL, AND LEFT THAT WAY. Only a create or PATCH that sets a new
 * binding asks — not every turn — and the snapshot is a small local file; a cache keyed on its mtime
 * would be one more thing to keep in step with the writer for no request a student would notice.
 */
export const opensConversation = Effect.fn("JolliCourseGuardrails.opensConversation")(function* (
  binding: CourseBinding,
) {
  const jolli = yield* JolliSession.Service
  const row = yield* jolli.current().pipe(Effect.catchCause(() => Effect.succeed(undefined)))
  const request = row?.base_url
    ? gatewayRequest(row.base_url, { token: row.access_token, identity: row.cache_key })
    : undefined
  if (!request) return undefined
  const snapshot = yield* readCatalog(request)
  return snapshot ? assistantIn(snapshot, binding)?.opensConversation : undefined
})

/**
 * The bound assistant's switches, or undefined when the catalogue cannot say: no usable credential,
 * no catalogue at all, or an assistant that is not this course's. It never fails.
 */
export const resolve = Effect.fn("JolliCourseGuardrails.resolve")(function* (input: {
  readonly request: GatewayRequest | undefined
  readonly binding: CourseBinding
}) {
  return (yield* lookup(input))?.guardrails
})

const lookup = Effect.fn("JolliCourseGuardrails.lookup")(function* (input: {
  readonly request: GatewayRequest | undefined
  readonly binding: CourseBinding
}) {
  if (!input.request) return undefined
  const loaded = yield* loadCatalog(input.request, { timeout: TIMEOUT }).pipe(
    Effect.catchCause(() => Effect.succeed(undefined)),
  )
  if (loaded?.kind !== "ok") return undefined
  return assistantIn(loaded.snapshot, input.binding)
})

function assistantIn(snapshot: CatalogSnapshot, binding: CourseBinding) {
  const assistant = Lookup.assistantById(projectCatalog(snapshot, today()), binding.assistantId)
  if (!assistant || assistant.courseId !== binding.courseId) return undefined
  return assistant
}
