export * as JolliSkills from "./skills"

import { Effect, Fiber, Schedule } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import {
  createCourseSkillReference,
  fetchCourseSkills,
  openConversation,
  JolliApiError,
  type CourseSkillReference,
  type CourseSkillChoice,
  type GatewayRequest,
} from "./api"
import { courseBindingOf, type SessionLike } from "./binding"
import { JolliSession } from "./session"
import { nameOf } from "./skill-name"

export { PREFIX, isCourse, nameOf } from "./skill-name"

export type Session = SessionLike & { readonly id: string }
export type Summary = CourseSkillChoice & { readonly toolName: string }

type CatalogEntry = {
  readonly sessionId: string
  value?: Summary[]
  pending?: Effect.Effect<Summary[], JolliApiError>
}
const catalogs = new WeakMap<JolliSession.Interface, Map<string, CatalogEntry>>()

export const isRefused = (error: JolliApiError) =>
  error.status !== undefined && [400, 401, 403, 404, 409].includes(error.status)

const request = <A>(
  jolli: JolliSession.Interface,
  operation: (request: GatewayRequest) => Effect.Effect<A, JolliApiError, HttpClient.HttpClient>,
) =>
  Effect.gen(function* () {
    const gateway = yield* jolli.request().pipe(
      Effect.mapError(
        (cause) =>
          new JolliApiError({
            path: "/api/agent/convos",
            message: "Could not authenticate skill request",
            ...(cause._tag === "Jolli.SignedOut" ? { status: 401 } : {}),
            cause,
          }),
      ),
    )
    if (!gateway)
      return yield* new JolliApiError({
        path: "/api/agent/convos",
        status: 401,
        message: "Sign in to Jolli to load course skills",
      })
    return yield* operation(gateway).pipe(
      Effect.catch((error) => {
        if (error.status !== 401) return Effect.fail(error)
        return jolli.refused(gateway.token).pipe(
          Effect.mapError(() => error),
          Effect.flatMap((token) => (token === gateway.token ? Effect.fail(error) : operation({ ...gateway, token }))),
        )
      }),
    )
  }).pipe(
    Effect.tapError((error) =>
      Effect.sync(() => {
        if (error.status === 401) catalogs.delete(jolli)
      }),
    ),
    Effect.provide(FetchHttpClient.layer),
  )

/** Refresh per user turn. Successful metadata is reusable; transient failures are never cached. */
export const list = (
  jolli: JolliSession.Interface,
  session: Session | undefined,
  refresh = false,
): Effect.Effect<Summary[], JolliApiError> => {
  const binding = courseBindingOf(session)
  if (!session || !binding) return Effect.succeed([])
  return Effect.suspend(() => {
    const observed: { entry?: CatalogEntry } = {}
    return request(jolli, (gateway) =>
      Effect.gen(function* () {
        const cache = catalogs.get(jolli) ?? new Map<string, CatalogEntry>()
        catalogs.set(jolli, cache)
        const key = JSON.stringify([gateway.origin, gateway.tenantSlug, gateway.identity, session.id, binding])
        const entry: CatalogEntry = cache.get(key) ?? { sessionId: session.id }
        observed.entry = entry
        if (!entry.pending && !refresh && entry.value) return entry.value
        if (!entry.pending) {
          entry.pending = yield* Effect.cached(
            fetchCourseSkills(gateway, session.id).pipe(
              Effect.catch((error) => {
                if (error.status !== 404) return Effect.fail(error)
                // Ensure the remote binding exists; every refusal still passes through session access.
                return openConversation(gateway, {
                  spaceId: Number(binding.courseId),
                  courseAssistantId: Number(binding.assistantId),
                  publicSessionId: session.id,
                }).pipe(Effect.andThen(fetchCourseSkills(gateway, session.id)))
              }),
              Effect.map((skills) => skills.map((skill) => ({ ...skill, toolName: nameOf(skill.command) }))),
              Effect.timeout("5 seconds"),
              Effect.mapError((cause) =>
                cause instanceof JolliApiError
                  ? cause
                  : new JolliApiError({
                      path: `/api/agent/convos/${session.id}/skills`,
                      message: "Course skill catalog request timed out",
                      cause,
                    }),
              ),
              Effect.tap((value) =>
                Effect.sync(() => {
                  entry.value = value
                }),
              ),
              Effect.catch((error) => {
                if (isRefused(error)) {
                  entry.value = undefined
                  return Effect.fail(error)
                }
                return Effect.logWarning("Jolli: course skill catalog unavailable", {
                  sessionID: session.id,
                  error,
                }).pipe(Effect.andThen(entry.value ? Effect.succeed(entry.value) : Effect.fail(error)))
              }),
              Effect.ensuring(
                Effect.sync(() => {
                  entry.pending = undefined
                }),
              ),
              Effect.provide(FetchHttpClient.layer),
            ),
          )
          cache.set(key, entry)
          if (cache.size > 128) cache.delete(cache.keys().next().value!)
        }
        // A caller may cancel its wait without interrupting the shared, bounded producer.
        const producer = yield* entry.pending.pipe(Effect.forkDetach)
        return yield* Fiber.join(producer)
      }),
    ).pipe(
      Effect.timeout("5 seconds"),
      Effect.catchTag("TimeoutError", (cause) => {
        const error = new JolliApiError({
          path: `/api/agent/convos/${session.id}/skills`,
          message: "Course skill catalog request timed out",
          cause,
        })
        return observed.entry?.value ? Effect.succeed(observed.entry.value) : Effect.fail(error)
      }),
    )
  })
}

export const select = (jolli: JolliSession.Interface, session: Session, name: string) =>
  list(jolli, session).pipe(
    Effect.flatMap((skills) => {
      const selected = skills.find((skill) => skill.toolName === name)
      return selected
        ? Effect.succeed(selected)
        : Effect.fail(
            new JolliApiError({ path: "/api/agent/convos", message: "Course skill is not available in this session" }),
          )
    }),
  )

/** The ordinary tool history stores only this reference, never the teacher's instructions. */
export const load = (jolli: JolliSession.Interface, session: Session, name: string, toolCallId: string) =>
  Effect.gen(function* () {
    const selected = yield* select(jolli, session, name)
    const reference = yield* request(jolli, (gateway) =>
      createCourseSkillReference(gateway, session.id, selected.id, toolCallId, name),
    ).pipe(
      Effect.retry({ times: 2, schedule: Schedule.spaced("100 millis"), while: (error) => error.status === 404 }),
      Effect.tapError((error) =>
        Effect.sync(() => {
          if (!isRefused(error)) return
          for (const entry of catalogs.get(jolli)?.values() ?? []) {
            if (entry.sessionId === session.id) entry.value = undefined
          }
        }),
      ),
    )
    if (nameOf(reference.command) !== name || reference.skillId !== selected.id)
      return yield* new JolliApiError({
        path: "/api/agent/convos",
        message: "Course skill changed; reload the skill catalog",
      })
    return reference
  })

export const render = (reference: CourseSkillReference) => JSON.stringify(reference)
