export * as JolliSkills from "./skills"

import { Effect, Fiber, Result, Schedule } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import {
  createCourseSkillReference,
  forkCourseSkills,
  type SkillInvocationSource,
  fetchCourseSkills,
  fetchAssistantChoices,
  JolliApiError,
  type CourseSkillReference,
  type CourseSkillChoice,
  type GatewayRequest,
} from "./api"
import { courseBindingOf, type SessionLike } from "./binding"
import type { JolliStore } from "./store"
import { JolliSession } from "./session"
import { parseJolliUrl } from "./origin"
import { CourseSkillName } from "@opencode-ai/schema/course-skill-name"

export type Session = SessionLike & { readonly id: string }
export type Summary = CourseSkillChoice & { readonly toolName: string }

type CatalogEntry = {
  readonly sessionId: string
  checkedAt: number
  value?: Result.Result<Summary[], JolliApiError>
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
      Effect.timeout("5 seconds"),
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
          Effect.timeout("5 seconds"),
          Effect.mapError(
            (cause) =>
              new JolliApiError({
                path: "/api/agent/convos",
                message: "Could not renew skill request authentication",
                ...(cause._tag === "Jolli.SignedOut" ? { status: 401 } : {}),
                cause,
              }),
          ),
          Effect.flatMap((token) => (token === gateway.token ? Effect.fail(error) : operation({ ...gateway, token }))),
        )
      }),
    )
  }).pipe(Effect.provide(FetchHttpClient.layer))

const scopeOf = (credential: JolliStore.Row | undefined) =>
  credential?.base_url && URL.canParse(credential.base_url)
    ? { ...parseJolliUrl(credential.base_url), identity: credential.cache_key }
    : undefined

/** Refresh per user turn; cache refusals briefly and preserve warm metadata on transient failures. */
export const list = (
  jolli: JolliSession.Interface,
  session: Session | undefined,
  refresh = false,
): Effect.Effect<Summary[], JolliApiError> => {
  const binding = courseBindingOf(session)
  if (!session || !binding) return Effect.succeed([])
  return Effect.gen(function* () {
    const scope = scopeOf(yield* jolli.current())
    if (!scope) {
      catalogs.delete(jolli)
      return yield* new JolliApiError({
        path: "/api/agent/convos",
        status: 401,
        message: "Sign in to Jolli to load course skills",
      })
    }
    const cache = catalogs.get(jolli) ?? new Map<string, CatalogEntry>()
    catalogs.set(jolli, cache)
    const key = JSON.stringify([scope.origin, scope.tenantSlug, scope.identity, session.id, binding])
    const entry: CatalogEntry = cache.get(key) ?? { sessionId: session.id, checkedAt: 0 }
    cache.set(key, entry)
    if (cache.size > 128) cache.delete(cache.keys().next().value!)
    if (!refresh && entry.value && Date.now() - entry.checkedAt < 60_000) return yield* Effect.fromResult(entry.value)
    if (!entry.pending) {
      const pending: Effect.Effect<Summary[], JolliApiError> = yield* Effect.cached(
        request(jolli, (gateway) => {
          if (
            gateway.origin !== scope.origin ||
            gateway.tenantSlug !== scope.tenantSlug ||
            gateway.identity !== scope.identity
          )
            return Effect.fail(
              new JolliApiError({
                path: "/api/agent/convos",
                message: "The active Jolli account changed while loading course skills",
              }),
            )
          return fetchCourseSkills(gateway, session.id).pipe(
            Effect.catch((error) => {
              if (error.status !== 404) return Effect.fail(error)
              // An unsynced CLI session may read public metadata without creating a remote conversation.
              return fetchAssistantChoices(gateway, Number(binding.courseId)).pipe(
                Effect.flatMap((choices) => {
                  const assistant = choices.find((choice) => choice.id === Number(binding.assistantId))
                  return assistant ? Effect.succeed(assistant.skills ?? []) : Effect.fail(error)
                }),
              )
            }),
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
          )
        }).pipe(
          Effect.map((skills) =>
            skills.map((skill) => ({ ...skill, toolName: CourseSkillName.nameOf(skill.command) })),
          ),
          Effect.result,
          Effect.flatMap((result) =>
            Effect.gen(function* () {
              const active = scopeOf(yield* jolli.current())
              if (
                active?.origin !== scope.origin ||
                active?.tenantSlug !== scope.tenantSlug ||
                active?.identity !== scope.identity
              ) {
                entry.value = undefined
                return []
              }
              // Invalidation detaches the old producer. It must never publish stale metadata or a fake HTTP refusal.
              if (entry.pending !== pending) return yield* Effect.fromResult(entry.value ?? Result.succeed([]))
              entry.checkedAt = Date.now()
              if (Result.isSuccess(result) || isRefused(result.failure)) entry.value = result
              if (Result.isFailure(result) && !isRefused(result.failure)) {
                yield* Effect.logWarning("Jolli: course skill catalog unavailable", {
                  sessionID: session.id,
                  error: result.failure,
                })
                if (entry.value && Result.isSuccess(entry.value)) return entry.value.success
              }
              return yield* Effect.fromResult(result)
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              if (entry.pending === pending) entry.pending = undefined
            }),
          ),
        ),
      )
      entry.pending = pending
    }
    // A caller may cancel its wait without interrupting the shared, bounded producer.
    const producer = yield* entry.pending.pipe(Effect.forkDetach)
    return yield* Fiber.join(producer)
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

export const load = (
  jolli: JolliSession.Interface,
  session: Session,
  name: string,
  toolCallId: string,
  turnId?: string,
) =>
  select(jolli, session, name).pipe(Effect.flatMap((selected) => invoke(jolli, session, selected, toolCallId, turnId)))

/** Invoke metadata already resolved before permission approval without querying the catalog again. */
export const invoke = (
  jolli: JolliSession.Interface,
  session: Session,
  selected: Summary,
  toolCallId: string,
  turnId?: string,
  source?: SkillInvocationSource,
) =>
  Effect.gen(function* () {
    const name = selected.toolName
    const reference = yield* request(jolli, (gateway) =>
      createCourseSkillReference(gateway, {
        sessionID: session.id,
        skillId: selected.id,
        toolCallId,
        name,
        turnId,
        source,
      }),
    ).pipe(
      Effect.retry({ times: 2, schedule: Schedule.spaced("100 millis"), while: (error) => error.status === 404 }),
      Effect.tapError((error) =>
        Effect.gen(function* () {
          // A missing tool call or one invalid snapshot does not revoke the whole catalog.
          if (error.status !== 401 && error.status !== 403) return
          for (const entry of catalogs.get(jolli)?.values() ?? []) {
            if (error.status !== 401 && entry.sessionId !== session.id) continue
            entry.pending = undefined
            entry.value = Result.fail(error)
            entry.checkedAt = Date.now()
          }
        }),
      ),
    )
    if (CourseSkillName.nameOf(reference.command) !== name || reference.skillId !== selected.id)
      return yield* new JolliApiError({
        path: "/api/agent/convos",
        message: "Course skill changed; reload the skill catalog",
      })
    return reference
  })

export const render = (reference: CourseSkillReference) => JSON.stringify(reference)

/** Forks keep every historical snapshot, including older versions of the same skill. */
export const fork = (
  jolli: JolliSession.Interface,
  input: {
    readonly sourceSessionID: string
    readonly sessionID: string
    readonly references: ReadonlyArray<CourseSkillReference>
  },
) =>
  Effect.forEach(
    Array.from({ length: Math.ceil(input.references.length / 100) }, (_, index) =>
      input.references.slice(index * 100, (index + 1) * 100),
    ),
    (references) => request(jolli, (gateway) => forkCourseSkills(gateway, { ...input, references })),
    { concurrency: 1 },
  ).pipe(Effect.map((groups) => groups.flat()))
