/**
 * WHAT JOLLI EDU ACTUALLY RETURNS, DECODED — AND NOTHING ELSE.
 *
 * ⚠ THIS LAYER HUGS THE WIRE, ON PURPOSE. The shapes below are Jolli Edu's, field for field,
 * numeric ids included; the domain types this repo renders live in `@opencode-ai/schema/jolli` and
 * the mapping between them belongs to the caller. Keeping the two apart is what makes "the gateway
 * changed a field" a diff in one file rather than a hunt through the renderer.
 *
 * ⚠ AND IT HOLDS NO CREDENTIAL. Three surfaces need these calls and each gets its token from
 * somewhere different — the desktop from the OS keychain, the sidecar from its environment, the
 * bare CLI from `auth.json`. A module that reached for one would work on exactly one of them.
 *
 * Contract verified against jolliedu's `origin/main`:
 *   GET /api/courses                          CourseRouter.ts:1289   requireAuth()
 *   GET /api/courses/:id/assistant-choices    CourseRouter.ts:1993   spaces.view, 404-on-no-permission
 *   GET /api/agent/models                     AgentModelRouter.ts:21 any signed-in user
 * All three answer with a bare array — no envelope.
 */
import { Effect, Schedule, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Brand } from "../brand"
import { isJolliOriginAllowed, parseJolliUrl } from "./origin"

export class JolliApiError extends Schema.TaggedErrorClass<JolliApiError>()("Jolli.ApiError", {
  path: Schema.String,
  /** Absent when the request never got a response. */
  status: Schema.optional(Schema.Number),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/**
 * WHERE TO CALL AND AS WHOM.
 *
 * ⚠ `origin` IS AN ORIGIN, NEVER A TENANT URL WITH A PATH. Jolli mounts its API at the origin root
 * even when the tenant is addressed path-wise (`https://host/acme`), in which case the slug travels
 * as a header instead — concatenating an API path onto the tenant URL reaches the app router, not
 * the API. Build one with {@link gatewayRequest}, which makes that split for you.
 */
export interface GatewayRequest {
  readonly origin: string
  readonly tenantSlug?: string
  readonly token: string
}

/**
 * Split a tenant base URL (`https://acme.jolli.ai` or `https://host/acme`) into the origin every
 * route is mounted on and the slug a path-based deployment carries in a header.
 *
 * ⚠ IT RE-CHECKS THE ALLOWLIST rather than trusting whoever stored the URL. A long-lived process
 * can be holding a value that was allowlisted when it was read and is not any more, and this
 * request carries the student's credential — same reason `exchange.ts` re-checks.
 */
export function gatewayRequest(baseUrl: string, token: string): GatewayRequest | undefined {
  if (!URL.canParse(baseUrl)) return undefined
  if (!isJolliOriginAllowed(baseUrl)) return undefined
  const tenant = parseJolliUrl(baseUrl)
  return { origin: tenant.origin, ...(tenant.tenantSlug ? { tenantSlug: tenant.tenantSlug } : {}), token }
}

// ── The wire shapes ─────────────────────────────────────────────────────────────────────────────

/** jolliedu `common/src/types/Course.ts:126`. */
export const CourseListItem = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  code: Schema.String,
  /**
   * ⚠ DECODED AS A STRING, NARROWED LATER. A closed union here would fail the WHOLE array on one
   * unrecognised value, and `schemaBodyJson` has no per-element recovery — so the day Jolli Edu
   * adds a course status, every student is locked out of the app and told their network is down.
   * The mapping layer decides what an unknown status means; the wire decoder's job is to let the
   * response through.
   */
  status: Schema.String,
  /** Whether this course's work happens in Jolli Code. The professor sets it. */
  requiresCoding: Schema.Boolean,
  endsOn: Schema.NullOr(Schema.String),
  /**
   * The viewer's role in THIS course, and the only way to tell a course of theirs from one an
   * institution administrator merely has sight of — see the filter in `packages/opencode`.
   */
  /** Open for the same reason as {@link status}: a new role must not lock anybody out. */
  viewerRole: Schema.NullOr(Schema.String),
  isStaff: Schema.Boolean,
}).annotate({ identifier: "JolliApi.CourseListItem" })
export interface CourseListItem extends Schema.Schema.Type<typeof CourseListItem> {}

/**
 * jolliedu `common/src/types/CourseAssistant.ts:301`.
 *
 * ⚠ THE STUDENT'S SHAPE, NOT A FILTERED STAFF ONE. jolliedu serves it from a separate route for a
 * stated reason: the staff shape carries the teacher's `instructions`, and filtering that down in a
 * client is how a sentence written about a class reaches the class.
 *
 * ⚠ ONLY `live` ASSISTANTS ARE RETURNED, AND THE DEFAULT IS FIRST. There is no `isDefault` flag —
 * the order IS the answer, so re-sorting this loses the professor's choice.
 */
export const CourseAssistantChoice = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  blurb: Schema.String,
  /** A closed set of 16 names the client maps to a glyph; kept loose here, narrowed on mapping. */
  icon: Schema.String,
  accent: Schema.Number,
  worksThroughProblems: Schema.Boolean,
  answersFromMaterialsOnly: Schema.Boolean,
  showCitations: Schema.Boolean,
  /** A Registry UUID. Never null: only a `live` assistant is offered and `live` requires a model. */
  modelId: Schema.String,
  /** Registry UUIDs. Empty means UNRESTRICTED, not "no models". */
  allowedModelIds: Schema.Array(Schema.String),
}).annotate({ identifier: "JolliApi.CourseAssistantChoice" })
export interface CourseAssistantChoice extends Schema.Schema.Type<typeof CourseAssistantChoice> {}

/** jolliedu `common/src/types/AgentHub.ts:44`. */
export const AgentModel = Schema.Struct({
  /** The Registry UUID that `allowedModelIds` names. */
  id: Schema.String,
  /** The public model name the LLM router accepts, e.g. `claude-sonnet-4-5`. */
  name: Schema.String,
  /** Open for the same reason as the course fields; an unknown tier simply produces no nudge. */
  category: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
  isActive: Schema.Boolean,
}).annotate({ identifier: "JolliApi.AgentModel" })
export interface AgentModel extends Schema.Schema.Type<typeof AgentModel> {}

const AgentModelProvider = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /**
   * The wire protocol this provider's models are reached over. Held as an open
   * string for the same reason `CourseListItem.status` is: a value the client
   * has not heard of must not fail the whole array, and the mapping layer picks
   * a safe default when it meets one.
   */
  protocol: Schema.String,
  isActive: Schema.Boolean,
  models: Schema.Array(AgentModel),
}).annotate({ identifier: "JolliApi.AgentModelProvider" })

// ── The calls ───────────────────────────────────────────────────────────────────────────────────

const retry = Schedule.exponential(200).pipe(Schedule.jittered)

const get = Effect.fn("Jolli.get")(function* <A, I>(request: GatewayRequest, path: string, schema: Schema.Codec<A, I>) {
  const http = HttpClient.filterStatusOk(
    (yield* HttpClient.HttpClient).pipe(
      HttpClient.retryTransient({ retryOn: "errors-and-responses", times: 2, schedule: retry }),
    ),
  )
  return yield* HttpClientRequest.get(new URL(path, request.origin).toString()).pipe(
    HttpClientRequest.bearerToken(request.token),
    HttpClientRequest.setHeader("User-Agent", Brand.userAgent()),
    // The API is mounted on the origin, so a path-addressed tenant names itself in a header.
    request.tenantSlug ? HttpClientRequest.setHeader("x-tenant-slug", request.tenantSlug) : (r) => r,
    http.execute,
    Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
    Effect.timeout("15 seconds"),
    Effect.catch((cause) => {
      /**
       * ⚠ THE `response` FIELD EXISTS EVEN WHEN THERE WAS NO RESPONSE. A transport failure — DNS,
       * a refused connection, the student's train going into a tunnel — is a `RequestError`, which
       * declares the field and leaves it undefined, so testing only for its presence and reaching
       * through it threw INSIDE the error constructor. That turned every offline request into a
       * defect, and a defect is not what `loadCatalog` catches: the stale-cache fallback never ran
       * and the sidecar's config load died instead.
       */
      const response = typeof cause === "object" && cause !== null && "response" in cause ? cause.response : undefined
      const status =
        typeof response === "object" && response !== null && "status" in response ? response.status : undefined
      return Effect.fail(
        new JolliApiError({
          path,
          ...(typeof status === "number" ? { status } : {}),
          message: `Jolli request failed: GET ${path}`,
          cause,
        }),
      )
    }),
  )
})

/** Every course the signed-in user can see. NOT only theirs — see `CourseListItem.viewerRole`. */
export const fetchCourses = (request: GatewayRequest) => get(request, "/api/courses", Schema.Array(CourseListItem))

/** The `live` assistants of one course, default first. 404 means "no permission" OR "no course". */
export const fetchAssistantChoices = (request: GatewayRequest, courseId: number) =>
  get(request, `/api/courses/${courseId}/assistant-choices`, Schema.Array(CourseAssistantChoice))

/**
 * A chat model with its owning provider's wire protocol denormalised onto it.
 *
 * ⚠ `protocol` IS NOT ON THE WIRE `AgentModel` — jolliedu declares it on the
 * `AgentModelProvider` group and every model inside that group inherits it. The
 * wire schema stays faithful to what the gateway returns; this shape is what
 * downstream code (`toProviderModels`, `modelKey`) needs to route one call to
 * the right upstream SDK.
 */
export interface CatalogModel extends AgentModel {
  readonly protocol: string
}

/**
 * The whole chat-model catalogue, flattened to `UUID -> model + its protocol`.
 *
 * ⚠ EACH MODEL CARRIES ITS PROVIDER'S PROTOCOL. Downstream code (the provider
 * config generator, the assistant mapper) uses it to decide which `@ai-sdk/*`
 * package to route the call through and which HTTP path to hit. Dropping the
 * grouping is still fine — Jolli Code still shows one provider to the student —
 * but the routing key that used to be implicit is now explicit on every model.
 *
 * ⚠ A DISABLED PROVIDER TAKES ITS WHOLE GROUP WITH IT, which is the field's documented meaning.
 */
export const fetchModelIndex = (request: GatewayRequest) =>
  get(request, "/api/agent/models", Schema.Array(AgentModelProvider)).pipe(
    Effect.map((providers) => {
      const index = new Map<string, CatalogModel>()
      for (const provider of providers) {
        if (!provider.isActive) continue
        for (const model of provider.models) {
          if (model.isActive) index.set(model.id, { ...model, protocol: provider.protocol })
        }
      }
      return index
    }),
  )
