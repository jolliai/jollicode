/**
 * THE SWITCHES OF THE ASSISTANT A SESSION IS BOUND TO, AS THE STUDENT'S CATALOGUE STATES THEM.
 *
 * ⚠ FOR WHAT THIS PROCESS DRAWS, ACCEPTS OR OFFERS, NEVER FOR WHAT THE MODEL IS TOLD. The gateway
 * applies the course to every model request of a bound session — the assistant's briefing, its
 * guardrails, the per-turn rule — on the server, so nothing here shapes a prompt. What this answers is
 * whether the student is shown something beside the answer, such as the sources it rests on, whether
 * a session may be bound to the assistant without Start, and whether the assignment tools are offered.
 *
 * ⚠ THE CATALOGUE MAY BE MINUTES BEHIND THE GATEWAY. It is a cached snapshot, so a teacher's edit can
 * reach the model a few minutes before it reaches what this process draws.
 */
export * as JolliCourseGuardrails from "./course-guardrails"

import { Duration, Effect, Option } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { fetchAssistantChoices, gatewayRequest, type GatewayRequest } from "./api"
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
 * How long one reading of an assistant's assignment switch answers for. Asked before every model step
 * — by the runner, the tool list and each code-mode call — so a turn of many steps asks the gateway
 * once rather than once a step; short, so a teacher turning assignments off reaches the next turn.
 */
const ASSIGNMENTS_TTL = Duration.seconds(30)

/** The last reading of each bound assistant's assignment switch, by who read it. */
const assignmentReadings = new Map<string, { readonly included: boolean; readonly at: number }>()

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
 * Whether the bound assistant's assignment tools may be offered, read off the gateway rather than the
 * catalogue snapshot, which may be minutes behind; an unknown policy withholds them.
 *
 * ⚠ A FAILED READ KEEPS THE LAST ANSWER. The tool list is rebuilt before every step, so falling back
 * to "withheld" on one slow request would take the tool from the model mid-turn and hand it back on the
 * next step. Only a binding never read yet starts out withheld.
 */
export const assignmentsIncluded = Effect.fn("JolliCourseGuardrails.assignmentsIncluded")(function* (
  binding: CourseBinding,
) {
  const jolli = yield* Effect.serviceOption(JolliSession.Service)
  if (Option.isNone(jolli)) return false
  return yield* Effect.gen(function* () {
    const request = yield* jolli.value.request().pipe(Effect.timeout(TIMEOUT))
    if (!request) return false
    const key = [request.origin, request.identity, binding.courseId, binding.assistantId].join("\n")
    const known = assignmentReadings.get(key)
    if (known && Date.now() - known.at < Duration.toMillis(ASSIGNMENTS_TTL)) return known.included
    return yield* fetchAssistantChoices(request, Number(binding.courseId)).pipe(
      Effect.map(
        (choices) => choices.find((choice) => String(choice.id) === binding.assistantId)?.includeAssignments === true,
      ),
      Effect.tap((included) => Effect.sync(() => assignmentReadings.set(key, { included, at: Date.now() }))),
      Effect.timeout(TIMEOUT),
      Effect.catchCause(() => Effect.succeed(known?.included ?? false)),
    )
  }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.catchCause(() => Effect.succeed(false)),
  )
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
