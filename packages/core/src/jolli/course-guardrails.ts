/**
 * THE SWITCHES OF THE ASSISTANT A SESSION IS BOUND TO, AS THE STUDENT'S CATALOGUE STATES THEM.
 *
 * ⚠ FOR WHAT THIS PROCESS DRAWS, NEVER FOR WHAT THE MODEL IS TOLD. The gateway applies the course to
 * every model request of a bound session — the assistant's briefing, its guardrails, the per-turn
 * rule — on the server, so nothing here shapes a prompt or withholds a tool. What this answers is
 * whether the student is shown something beside the answer, such as the sources it rests on.
 *
 * ⚠ THE CATALOGUE MAY BE MINUTES BEHIND THE GATEWAY. It is a cached snapshot, so a teacher's edit can
 * reach the model a few minutes before it reaches what this process draws.
 */
export * as JolliCourseGuardrails from "./course-guardrails"

import { Duration, Effect } from "effect"
import type { GatewayRequest } from "./api"
import type { CourseBinding } from "./binding"
import { loadCatalog } from "./cache"
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
  return yield* resolve({ request, binding })
})

/**
 * The bound assistant's switches, or undefined when the catalogue cannot say: no usable credential,
 * no catalogue at all, or an assistant that is not this course's. It never fails.
 */
export const resolve = Effect.fn("JolliCourseGuardrails.resolve")(function* (input: {
  readonly request: GatewayRequest | undefined
  readonly binding: CourseBinding
}) {
  if (!input.request) return undefined
  const loaded = yield* loadCatalog(input.request, { timeout: TIMEOUT }).pipe(
    Effect.catchCause(() => Effect.succeed(undefined)),
  )
  if (loaded?.kind !== "ok") return undefined
  const catalog = projectCatalog(loaded.snapshot, today())
  const assistant = Lookup.assistantById(catalog, input.binding.assistantId)
  if (!assistant || assistant.courseId !== input.binding.courseId) return undefined
  return assistant.guardrails
})
