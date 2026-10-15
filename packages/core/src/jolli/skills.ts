export * as JolliSkills from "./skills"

import { Effect } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import {
  fetchAssistantChoices,
  fetchCourseSkill,
  fetchCourseSkills,
  JolliApiError,
  type CourseSkill,
  type CourseSkillChoice,
  type GatewayRequest,
} from "./api"
import { courseBindingOf, type SessionLike } from "./binding"
import { JolliSession } from "./session"
import { nameOf } from "./skill-name"
import { escapeHtml } from "../util/html"

export { PREFIX, isCourse, nameOf } from "./skill-name"

export type Session = SessionLike & { readonly id: string }
export type Summary = CourseSkillChoice & { readonly toolName: string }

type CatalogEntry = {
  value?: Summary[]
  failure?: JolliApiError
  pending?: Effect.Effect<Summary[], JolliApiError, HttpClient.HttpClient>
  confirmed: boolean
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

/** Refresh at each user turn; automatic tool steps reuse metadata, never instruction bodies. */
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
        const entry: CatalogEntry = cache.get(key) ?? { confirmed: false }
        observed.entry = entry
        if (entry.pending) return yield* entry.pending
        if (!refresh && entry.value) return entry.value
        if (!refresh && entry.failure) return yield* entry.failure
        const pending = yield* Effect.cached(
          fetchCourseSkills(gateway, session.id).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                entry.confirmed = true
              }),
            ),
            Effect.catch((error) => {
              if (error.status !== 404 || entry.confirmed) return Effect.fail(error)
              // Only an initial discovery may fall back for a session not yet recorded upstream.
              return fetchAssistantChoices(gateway, Number(binding.courseId)).pipe(
                Effect.map(
                  (choices) => choices.find((choice) => String(choice.id) === binding.assistantId)?.skills ?? [],
                ),
              )
            }),
            Effect.map((skills) => skills.map((skill) => ({ ...skill, toolName: nameOf(skill.command) }))),
            Effect.timeout("5 seconds"),
            Effect.mapError((error) =>
              error instanceof JolliApiError
                ? error
                : new JolliApiError({
                    path: `/api/agent/convos/${session.id}/skills`,
                    message: "Course skill catalog request timed out",
                    cause: error,
                  }),
            ),
            Effect.tap((value) =>
              Effect.sync(() => {
                entry.value = value
                entry.failure = undefined
              }),
            ),
            Effect.catch((error) => {
              // A refreshed credential must retry immediately rather than replaying the old 401.
              entry.failure = error.status === 401 ? undefined : error
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
          ),
        )
        entry.pending = pending
        cache.set(key, entry)
        if (cache.size > 128) cache.delete(cache.keys().next().value!)
        return yield* pending
      }),
    ).pipe(
      // Include credential renewal in the deadline, as well as the HTTP catalog request.
      Effect.timeout("5 seconds"),
      Effect.catchTag("TimeoutError", (cause) => {
        const error = new JolliApiError({
          path: `/api/agent/convos/${session.id}/skills`,
          message: "Course skill catalog request timed out",
          cause,
        })
        if (observed.entry) observed.entry.failure = error
        return Effect.logWarning("Jolli: course skill catalog unavailable", { sessionID: session.id, error }).pipe(
          Effect.andThen(observed.entry?.value ? Effect.succeed(observed.entry.value) : Effect.fail(error)),
        )
      }),
    )
  })
}

/** A load is always authenticated again; callers persist the returned body as the ordinary skill tool result. */
export const load = (jolli: JolliSession.Interface, session: Session, name: string) =>
  Effect.gen(function* () {
    const selected = (yield* list(jolli, session)).find((skill) => skill.toolName === name)
    if (!selected)
      return yield* new JolliApiError({
        path: "/api/agent/convos",
        message: "Course skill is not available in this session",
      })
    const skill = yield* request(jolli, (gateway) => fetchCourseSkill(gateway, session.id, selected.id)).pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          if (isRefused(error)) {
            for (const entry of catalogs.get(jolli)?.values() ?? []) entry.value = undefined
          }
        }),
      ),
    )
    if (nameOf(skill.command) !== name)
      return yield* new JolliApiError({
        path: "/api/agent/convos",
        message: "Course skill changed; reload the skill catalog",
      })
    return skill
  })

export const render = (skill: CourseSkill) =>
  [
    `<skill_content name="${escapeHtml(nameOf(skill.command))}">`,
    `# Skill: ${escapeHtml(skill.name)}`,
    "",
    skill.instructions,
    "",
    "This course skill applies to the request that loaded it and the exchange that request starts.",
    "</skill_content>",
  ].join("\n")
