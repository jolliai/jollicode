import { Effect, Option, Schema } from "effect"
import { Jolli } from "@opencode-ai/schema/jolli"
import { JolliApiError, scopedRequest, type GatewayRequest } from "./api"
import { readCatalog } from "./cache"
import { onJolliSessionChanged } from "./session"
import {
  groupChatID,
  parseGroupChatID,
  orgScopedId,
  orgScopeHeaders,
  parseOrgScopedId,
  sameOrg,
  type OrgScope,
} from "./org-scoped-id"

function environmentKey(request: GatewayRequest) {
  return JSON.stringify([request.identity, request.origin, request.tenantSlug ?? ""])
}

/**
 * A chat in the home org is addressed without a scope. While the home org is unknown the scope is
 * sent anyway, which the server resolves to the caller's own org exactly as an unscoped request.
 */
export function chatRequest(request: GatewayRequest, id: Jolli.GroupChatID) {
  const parsed = parseGroupChatID(id)
  const scope = sameOrg(homes.get(environmentKey(request)), parsed.scope) ? undefined : parsed.scope
  return { request: { ...request, scope }, path: chatPath(id) }
}

function chatPath(id: Jolli.GroupChatID) {
  return `/api/agent/convos/${encodeURIComponent(parseGroupChatID(id).publicId)}`
}

export function requestHeaders(request: GatewayRequest) {
  return {
    Authorization: `Bearer ${request.token}`,
    ...(request.tenantSlug ? { "x-tenant-slug": request.tenantSlug } : {}),
    ...orgScopeHeaders(request.scope),
  }
}

const RefusalBody = Schema.Struct({
  code: Schema.String.pipe(Schema.optional),
  error: Schema.String.pipe(Schema.optional),
})

/**
 * No automatic write retries: a response lost after admission is an uncertain send.
 *
 * The timeout covers the headers and, for anything but an event stream, the body as well. An agent
 * ask (`stream`) answers with its turn's event stream and is bounded only by the caller's signal.
 */
export async function fetchGroupResource(
  request: GatewayRequest,
  path: string,
  method = "GET",
  body?: object,
  signal?: AbortSignal,
  stream = false,
) {
  const timeout = new AbortController()
  const timer = stream
    ? undefined
    : setTimeout(() => timeout.abort(new DOMException("The group chat request timed out", "TimeoutError")), 15_000)
  timer?.unref()
  const response = await fetch(new URL(path, request.origin), {
    method,
    signal: AbortSignal.any([...(signal ? [signal] : []), timeout.signal]),
    redirect: "error",
    headers: { ...requestHeaders(request), ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).catch((cause) => {
    clearTimeout(timer)
    throw new JolliApiError({ path, message: "Group chat could not be reached", cause })
  })
  if (response.headers.get("content-type")?.includes("text/event-stream")) clearTimeout(timer)
  if (response.ok) return response
  const detail = Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.fromJsonString(RefusalBody))(await response.text().catch(() => "")),
  )
  clearTimeout(timer)
  throw new JolliApiError({
    path,
    status: response.status,
    // Tenant refusals such as `sso_required` put their code in `error` on some servers.
    code: detail?.code ?? (detail?.error && /^[a-z][a-z0-9_]*$/.test(detail.error) ? detail.error : undefined),
    explanation: detail?.error,
    // jolliedu answers every refusal as JSON with an `error`; an HTML page or another JSON shape is not its own.
    ...(detail?.error !== undefined && response.headers.get("content-type")?.includes("json")
      ? { fromGateway: true }
      : {}),
    message: `Group chat request failed: ${response.status}`,
  })
}

/** A body that stops arriving is no response, which may read the offline copy; a malformed one is not. */
export async function groupJson(response: Response, path: string): Promise<unknown> {
  const text = await response.text().catch((cause) => {
    throw new JolliApiError({ path, message: "Group chat response was interrupted", cause })
  })
  return Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(text)
}

/**
 * ⚠ THE ONE RULE FOR WHEN ACCESS TO A GROUP CHAT IS GONE, for the routes (`groupChatFailure`) and the live
 * streams alike. Only the chat's own word counts:
 * - a refusal labelled `conversation_access_revoked`, the access check's verdict;
 * - the chat's own open read (`opened`) refused 403 or 404 with no code, in jolliedu's own JSON error
 *   (`fromGateway`), which is how its admission answers a reader who may no longer read it
 *   ("Conversation not found").
 * A live stream's `session_revoked` frame is the third, and the stream reads it itself.
 *
 * A refusal that names any other code is a gate in front of the chat, not the chat: the school's sign-in
 * (`sso_required`), an org the request could not be placed in (`tenant_resolution_failed`, which jolliedu
 * answers alike for every reason on purpose), a tenant mismatch. So is a 403 or 404 on any other request:
 * jolliedu answers those for a request it could not place too. And so is a 403 or 404 page that something in
 * front of jolliedu answered with (a WAF, a CDN, an ingress that lost the route). None of them says the
 * reader lost the chat.
 */
export function accessRevoked(error: unknown, opened?: Jolli.GroupChatID) {
  if (!(error instanceof JolliApiError)) return false
  if (error.status === 404 && error.code === "conversation_access_revoked") return true
  return (
    opened !== undefined &&
    (error.status === 403 || error.status === 404) &&
    error.code === undefined &&
    error.fromGateway === true &&
    error.path === `${chatPath(opened)}/open`
  )
}

/**
 * What a failed group chat call means to the renderer. `revoked` follows {@link accessRevoked}; any other
 * 4xx refuses that one request. `opened` names the chat when the failure came from opening it; a page that
 * something in front of jolliedu answered that read with is `unreachable`, so the chat reads again rather
 * than taking a proxy's word as the chat's.
 */
export function groupChatFailure(error: unknown, opened?: Jolli.GroupChatID): Jolli.GroupChatAnswer {
  if (error instanceof Error && "_tag" in error && error._tag === "Jolli.SignedOut") return { status: "signed-out" }
  if (!(error instanceof JolliApiError)) return { status: "unreachable" }
  const code = error.code === undefined ? {} : { code: error.code }
  if (error.status === undefined)
    return error.code === undefined ? { status: "unreachable" } : { status: "refused", ...code }
  // ⚠ A 401 HERE OUTLIVED THE BRIDGE'S RENEWAL AND ITS ONE RETRY: the server refuses this credential. The renderer
  // takes `signed-out` as the credential gone and drops every group chat it holds, on purpose: a credential this
  // process cannot use counts as gone, and nothing is shown to a person the server will not confirm.
  if (error.status === 401) return { status: "signed-out", httpStatus: 401 }
  if (error.status < 400 || error.status >= 500) return { status: "unreachable", ...code }
  if (
    opened !== undefined &&
    error.path === `${chatPath(opened)}/open` &&
    error.code === undefined &&
    error.fromGateway !== true
  )
    return { status: "unreachable" }
  const message = error.explanation && error.explanation !== error.code ? { message: error.explanation } : {}
  return {
    status: accessRevoked(error, opened) ? "revoked" : "refused",
    ...code,
    httpStatus: error.status,
    ...message,
  }
}

const Org = Schema.Struct({ tenantSlug: Schema.String, orgSlug: Schema.String })
const homes = new Map<string, OrgScope>()
/** When a snapshot without a home may be read again; every group chat request asks, so a miss is kept briefly. */
const homeMisses = new Map<string, number>()
const viewers = new Map<string, number>()

/** The home org from memory or the catalogue snapshot on disk, never from the network. */
export async function knownGroupHome(request: GatewayRequest) {
  const key = environmentKey(request)
  const known = homes.get(key)
  if (known) return known
  if ((homeMisses.get(key) ?? 0) > Date.now()) return undefined
  const snapshot = await Effect.runPromise(readCatalog(request))
  if (!snapshot?.home) {
    homeMisses.set(key, Date.now() + 60_000)
    return undefined
  }
  const home = { tenantSlug: snapshot.home.tenantSlug, orgSlug: snapshot.home.orgSlug }
  homes.set(key, home)
  return home
}

async function groupHome(request: GatewayRequest, signal?: AbortSignal) {
  return (await knownGroupHome(request)) ?? (await groupEnvironment(request, signal)).home
}

/**
 * Who is signed in, for telling one's own messages apart: the credential's subject when it is a user
 * id, otherwise `/api/profile`, asked once per sign-in.
 */
export async function groupViewer(request: GatewayRequest, subject?: string | null, signal?: AbortSignal) {
  const claimed =
    subject && /^[1-9]\d*$/.test(subject) && Number.isSafeInteger(Number(subject)) ? Number(subject) : undefined
  const viewer =
    claimed ??
    viewers.get(request.identity) ??
    Schema.decodeUnknownSync(Schema.Struct({ userId: Schema.Int }))(
      await groupJson(await fetchGroupResource(request, "/api/profile", "GET", undefined, signal), "/api/profile"),
    ).userId
  viewers.set(request.identity, viewer)
  return viewer
}

const MessageItem = Schema.Struct({ kind: Schema.Literal("message") })
const Detail = Schema.Struct({
  title: Schema.String.pipe(Schema.optional),
  spaceId: Schema.NullOr(Schema.Number).pipe(Schema.optional),
  kind: Schema.String.pipe(Schema.optional),
  group: Jolli.GroupChatInfo,
  /** Only messages are read. Other items, including kinds added later, are skipped. */
  timeline: Schema.Array(Schema.Unknown),
  runtime: Schema.Struct({ isProcessing: Schema.Boolean }).pipe(Schema.optional),
  governance: Schema.Struct({ locked: Schema.Boolean, shareBlocked: Schema.Boolean }).pipe(Schema.optional),
})
const Opened = Schema.Union([
  Schema.Struct({ access: Schema.Literals(["owner", "participant"]), detail: Detail }),
  Schema.Struct({ access: Schema.Literal("reader"), transcript: Detail }),
])
const Summary = Schema.Struct({
  id: Schema.String,
  title: Schema.String.pipe(Schema.optional),
  updatedAt: Schema.String,
  courseSpaceId: Schema.Number.pipe(Schema.optional),
  spaceId: Schema.Number.pipe(Schema.optional),
  courseCode: Schema.String.pipe(Schema.optional),
  kind: Schema.String.pipe(Schema.optional),
  participantCount: Schema.Number.pipe(Schema.optional),
  unreadCount: Schema.Number.pipe(Schema.optional),
  isProcessing: Schema.Boolean.pipe(Schema.optional),
})

/** A chat never moves to another course, so its course is remembered from any open read. */
const chatCourses = new Map<string, number>()

/**
 * Open reads under way. jolliedu has no lighter answer that carries a chat's access and group, so the open
 * route, the composer's choices, the shares panel and a chat's course each read the whole chat, and a chat
 * page asks for several at once: identical reads share one request. Nothing is kept once it settles, so a
 * revocation is never answered from an earlier read. `callers` counts who still waits for it.
 */
const openReads = new Map<
  string,
  { read: Promise<typeof Opened.Type>; version?: number; callers: number; abort: AbortController }
>()

/**
 * The chat's own open read: the one request whose 403/404 means access to the chat is gone.
 *
 * Only a read made with the same token is joined: one made with a token since renewed or refused answers for
 * that token, and a 401 retry that joined it would only be refused again. `version` comes from a caller that
 * keeps what it reads offline: the offline copy's version it reads under. It joins only a read made under that
 * same version, because a read that set out before the copy was invalidated must not confirm it. Every other
 * caller joins whichever identical read is under way. A caller whose `signal` aborts stops waiting; the read
 * itself runs on for the others, and stops once nobody waits for it any more.
 */
export async function readChatOpen(
  request: GatewayRequest,
  id: Jolli.GroupChatID,
  signal?: AbortSignal,
  version?: number,
) {
  const target = chatRequest(request, id)
  const path = `${target.path}/open`
  const key = JSON.stringify([
    request.identity,
    request.token,
    request.origin,
    request.tenantSlug ?? "",
    target.request.scope,
    path,
  ])
  const under = openReads.get(key)
  /**
   * A caller that keeps nothing offline (no `version`: the composer's choices, the shares panel, a chat's course)
   * joins any identical read under way, even one that set out just before a revocation. It then gets what it
   * would have got by asking a moment earlier, and nothing more: it keeps no copy, and the server checks access
   * again on every action it leads to.
   */
  const shared =
    under && (version === undefined || under.version === version)
      ? under
      : startOpenRead(key, target.request, path, version)
  shared.callers++
  const opened = await untilAborted(shared.read, signal).finally(() => {
    shared.callers--
    if (shared.callers > 0) return
    // Nobody waits for it any more. A read that already answered has nothing left to cancel, and one still out
    // leaves the map at once, so a caller arriving now starts its own instead of joining a cancelled one.
    shared.abort.abort()
    if (openReads.get(key) === shared) openReads.delete(key)
  })
  const detail = "detail" in opened ? opened.detail : opened.transcript
  // The open read answered, and the conversation is not a group chat: its own word, as a refusal would be.
  if (detail.kind !== "group")
    throw new JolliApiError({ path, status: 404, fromGateway: true, message: "Group chat not found" })
  if (typeof detail.spaceId === "number") chatCourses.set(JSON.stringify([request.identity, id]), detail.spaceId)
  return { target, access: opened.access, detail }
}

/** Sends the open read `key` names, filed for identical reads to join until it settles. */
function startOpenRead(key: string, request: GatewayRequest, path: string, version?: number) {
  const abort = new AbortController()
  const read: Promise<typeof Opened.Type> = fetchGroupResource(request, path, "GET", undefined, abort.signal)
    .then((response) => groupJson(response, path))
    .then((body) => Schema.decodeUnknownSync(Opened)(body))
    .finally(() => {
      if (openReads.get(key)?.read === read) openReads.delete(key)
    })
  const started = { read, version, callers: 0, abort }
  openReads.set(key, started)
  return started
}

/** `promise`, or the signal's reason once it aborts first. */
function untilAborted<A>(promise: Promise<A>, signal?: AbortSignal) {
  if (!signal) return promise
  return new Promise<A>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    if (signal.aborted) return abort()
    signal.addEventListener("abort", abort, { once: true })
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
  })
}

/**
 * The chat's course as its own org numbers it, opening the chat only the first time. Undefined for a
 * chat that belongs to no course. That first time reads the whole chat (see `openReads`) for one number.
 */
export async function chatCourse(request: GatewayRequest, id: Jolli.GroupChatID) {
  return (
    chatCourses.get(JSON.stringify([request.identity, id])) ??
    (await readChatOpen(request, id)).detail.spaceId ??
    undefined
  )
}

/** The messages of an open read's timeline. Other items, including kinds added later, are skipped. */
function chatMessages(detail: { readonly timeline: readonly unknown[] }) {
  return detail.timeline.flatMap((item) =>
    Schema.is(MessageItem)(item) ? [Schema.decodeUnknownSync(Jolli.ChatMessage)(item)] : [],
  )
}

/**
 * The chat as the reader sees it now. `version` is the offline copy's version when the caller keeps the read
 * offline (see `readChatOpen`).
 */
export const openChat = Effect.fn("Jolli.groupChat.open")(function* (
  request: GatewayRequest,
  id: Jolli.GroupChatID,
  subject?: string | null,
  version?: number,
) {
  return yield* Effect.tryPromise({
    try: async (signal) => {
      // The home comes first: it decides whether the open read carries an org scope header (the home org
      // sends none), and after the first open it is in memory or the catalogue on disk. It is never a
      // reason the chat cannot open, and neither is the viewer: it needs nothing from the open read, so it
      // is asked alongside, and a lookup that fails opens the chat without one (`null`, which tells no
      // message apart as the reader's own) rather than failing a read that succeeded. It is not remembered,
      // so the next open asks again and fills it in, and the open route keeps no offline copy without one.
      const home = await groupHome(request, signal).catch(() => undefined)
      const viewer = groupViewer(request, subject, signal).catch(() => null)
      const opened = await readChatOpen(request, id, signal, version)
      const viewerId = await viewer
      const scope = parseGroupChatID(id).scope
      const spaceId = opened.detail.spaceId
      return {
        id,
        viewerId,
        webBaseUrl: `${request.origin}/t/${encodeURIComponent(scope.tenantSlug)}/o/${encodeURIComponent(scope.orgSlug)}`,
        title: opened.detail.title ?? "",
        // Without a known home a home course comes out scoped ("t:o:42") where the catalogue and the
        // chat list name it "42". The scoped form still names the course exactly to the server, so
        // reference reads keep working; lookups keyed by the catalogue's bare id (agent names, skills,
        // course filters on the offline list) miss it until then, where "" would match nothing at all.
        // It takes both the catalogue snapshot lacking a home and `/api/me/courses` failing on this open,
        // and the open route keeps no offline copy of such a read, so the cache never holds the scoped form.
        courseId:
          spaceId === undefined || spaceId === null
            ? ""
            : orgScopedId(sameOrg(scope, home) ? undefined : scope, spaceId),
        access: opened.access,
        processing: opened.access === "reader" ? false : (opened.detail.runtime?.isProcessing ?? false),
        locked: opened.detail.governance?.locked ?? false,
        shareBlocked: opened.detail.governance?.shareBlocked ?? false,
        group: opened.detail.group,
        messages: chatMessages(opened.detail),
      } satisfies Jolli.GroupChat
    },
    catch: asError,
  })
})

const GroupEnvironment = Schema.Struct({
  home: Org,
  courses: Schema.Array(Schema.Struct({ id: Schema.Int, org: Org })),
  /** Orgs that did not answer: their courses are missing from `courses`. */
  unavailable: Schema.Array(Org).pipe(Schema.optional),
})
/**
 * How long a complete course list is reused. Every message in any of the reader's chats refreshes the
 * chat list, and the courses behind it change far more rarely than that.
 */
const ENVIRONMENT_TTL_MS = 60_000
const environments = new Map<string, { value: GroupEnvironmentAnswer; expires: number }>()
type GroupEnvironmentAnswer = {
  readonly home: OrgScope
  readonly courses: readonly { readonly id: number; readonly org: OrgScope }[]
  readonly unavailable: readonly OrgScope[]
}

/** The reader's courses across every org. One that some org did not answer is asked again next time. */
export async function groupEnvironment(request: GatewayRequest, signal?: AbortSignal): Promise<GroupEnvironmentAnswer> {
  const key = environmentKey(request)
  const known = environments.get(key)
  if (known && known.expires > Date.now()) return known.value
  const result = Schema.decodeUnknownSync(GroupEnvironment)(
    await groupJson(await fetchGroupResource(request, "/api/me/courses", "GET", undefined, signal), "/api/me/courses"),
  )
  homes.set(key, result.home)
  const value = { home: result.home, courses: result.courses, unavailable: result.unavailable ?? [] }
  if (value.unavailable.length === 0) environments.set(key, { value, expires: Date.now() + ENVIRONMENT_TTL_MS })
  return value
}

/** How many pages of conversations one list read walks before it settles for an incomplete list. */
const LIST_PAGE_LIMIT = 5

const ChatPage = Schema.Struct({
  convos: Schema.Array(Schema.Struct({ ...Summary.fields, org: Org, ownership: Schema.String })),
  unavailable: Schema.Array(Org),
  nextCursor: Schema.String.pipe(Schema.optional),
})

/**
 * `courses` is the course catalogue, or undefined when it could not be read. Without it a row keeps
 * the course its org and space name, and the list is never complete: an incomplete list purges nothing.
 */
export const listChats = Effect.fn("Jolli.groupChat.list")(function* (
  request: GatewayRequest,
  courses: readonly { id: string }[] | undefined,
  courseId?: string,
) {
  return yield* Effect.tryPromise({
    try: async (signal) => {
      const read = async (cursor?: string) => {
        const path = `/api/me/agent-convos?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`
        return Schema.decodeUnknownSync(ChatPage)(
          await groupJson(await fetchGroupResource(request, path, "GET", undefined, signal), path),
        )
      }
      // The first page needs nothing from the course list, so the two are read together.
      const [setup, first] = await Promise.all([
        groupEnvironment(request, signal).then(async (environment) => ({
          environment,
          switches: await groupChatSwitches(request, environment, signal),
        })),
        read(),
      ])
      const environment = setup.environment
      const enabled = setup.switches.enabled
      const enabledCourseIds = environment.courses
        .filter((course) => enabled.has(course.org.tenantSlug))
        .map((course) => orgScopedId(sameOrg(course.org, environment.home) ? undefined : course.org, course.id))
      const rowsOf = (page: typeof first) =>
        page.convos.flatMap((row): Jolli.GroupChatSummary[] => {
          if (row.kind !== "group" || !enabled.has(row.org.tenantSlug)) return []
          // One id this client cannot address is skipped rather than failing the whole list. The list
          // stays complete: such a chat can never have an offline copy for the purge to keep.
          if (!Schema.is(Jolli.GroupChatID)(`${row.org.tenantSlug}:${row.org.orgSlug}:${row.id}`)) return []
          const space = row.courseSpaceId ?? row.spaceId
          const candidate =
            space === undefined ? "" : orgScopedId(sameOrg(row.org, environment.home) ? undefined : row.org, space)
          const knownCourseId =
            courses === undefined || courses.some((course) => course.id === candidate) ? candidate : ""
          if (courseId && knownCourseId !== courseId) return []
          return [
            {
              id: groupChatID(row.org, row.id),
              title: row.title ?? "",
              courseId: knownCourseId,
              courseCode: row.courseCode ?? "",
              updatedAt: row.updatedAt,
              participantCount: row.participantCount ?? 0,
              unreadCount: row.unreadCount ?? 0,
              processing: row.isProcessing ?? false,
              ownership: row.ownership,
            },
          ]
        })
      // The pages also hold direct chats, so a student with many of them could page on for every
      // refresh. Past the cap the list is reported incomplete, which purges nothing.
      const walk = async (pages: readonly (typeof first)[]): Promise<readonly (typeof first)[]> => {
        const cursor = pages.at(-1)?.nextCursor
        if (!cursor || pages.flatMap(rowsOf).length >= 64 || pages.length >= LIST_PAGE_LIMIT) return pages
        if (pages.slice(0, -1).some((page) => page.nextCursor === cursor)) throw new Error("Repeated group chat cursor")
        return walk([...pages, await read(cursor)])
      }
      const pages = await walk([first])
      const result = pages.flatMap(rowsOf)
      // A course list remembered from before the reader joined a course in another school lists none of
      // that school's chats as enabled, which would read as a complete list without them. Such a row
      // marks the list incomplete and the course list stale. (A chat shared from a school where the reader
      // has no course keeps every list incomplete, which only means nothing is purged.)
      const schools = new Set(environment.courses.map((course) => course.org.tenantSlug))
      const stale = pages.some((page) =>
        page.convos.some((row) => row.kind === "group" && !schools.has(row.org.tenantSlug)),
      )
      if (stale) environments.delete(environmentKey(request))
      return {
        chats: result.slice(0, 64),
        complete:
          courses !== undefined &&
          // A course the catalogue does not name (yet) matches no row, which is no word that it has no chats.
          (!courseId || courses.some((course) => course.id === courseId)) &&
          environment.unavailable.length === 0 &&
          setup.switches.complete &&
          !stale &&
          pages.every((page) => page.unavailable.length === 0) &&
          !pages.at(-1)?.nextCursor &&
          result.length <= 64,
        enabledCourseIds,
      }
    },
    catch: asError,
  })
})

/** How long a tenant's group chat switch is trusted before a list reads it again. */
const SWITCH_TTL_MS = 5 * 60_000
/** How long a tenant whose switch could not be read is left unread before a list asks it again. */
const SWITCH_MISS_TTL_MS = 60_000
const SessionConfig = Schema.Struct({ groupChatsEnabled: Schema.Boolean.pipe(Schema.optional) })
/** `enabled` is undefined for a tenant whose switch could not be read: unread, and asked again once it expires. */
const tenantSwitches = new Map<string, { enabled: boolean | undefined; expires: number }>()
// Another account, or none, reads every switch afresh.
onJolliSessionChanged(() => {
  tenantSwitches.clear()
  environments.clear()
})

/**
 * Which tenants of the student's courses have group chats switched on, asked of each tenant at most
 * once every few minutes because every message in any of the student's chats re-reads the list.
 *
 * ⚠ ONLY AN ANSWER THAT STATES THE SWITCH IS A READ. A tenant whose switch is neither remembered nor
 * stated now is off for this read and leaves the list incomplete, which purges nothing: a complete list
 * would purge the tenant's offline copies and drop its rows. That includes a 404 and a config without the
 * field, which a deployment that predates group chats answers, but so does one in the middle of a rollout
 * or a request the server could not place. Such a miss is remembered for a minute, not the switch's five:
 * lists are read again on every message nudge, and a burst of them must not ask a failing tenant each time.
 */
async function groupChatSwitches(
  request: GatewayRequest,
  environment: { readonly home: OrgScope; readonly courses: readonly { readonly org: OrgScope }[] },
  signal: AbortSignal,
) {
  const tenants = new Map(environment.courses.map((course) => [course.org.tenantSlug, course.org]))
  const answers = await Promise.all(
    Array.from(tenants.values(), async (org) => {
      const key = JSON.stringify([request.identity, org.tenantSlug])
      const known = tenantSwitches.get(key)
      if (known && known.expires > Date.now())
        return { tenant: org.tenantSlug, enabled: known.enabled === true, read: known.enabled !== undefined }
      const enabled = await fetchGroupResource(
        scopedRequest(request, sameOrg(org, environment.home) ? undefined : org),
        "/api/auth/session-config",
        "GET",
        undefined,
        signal,
      )
        .then((response) => groupJson(response, "/api/auth/session-config"))
        .then((body) => Schema.decodeUnknownSync(SessionConfig)(body).groupChatsEnabled)
        .catch(() => undefined)
      // A read the list itself gave up on asked the tenant nothing, so it is not remembered as a miss.
      if (enabled !== undefined || !signal.aborted)
        tenantSwitches.set(key, {
          enabled,
          expires: Date.now() + (enabled === undefined ? SWITCH_MISS_TTL_MS : SWITCH_TTL_MS),
        })
      return { tenant: org.tenantSlug, enabled: enabled === true, read: enabled !== undefined }
    }),
  )
  return {
    enabled: new Set(answers.flatMap((answer) => (answer.enabled ? [answer.tenant] : []))),
    /**
     * ⚠ ONE UNREAD TENANT LEAVES THE WHOLE LIST INCOMPLETE, SO WHILE IT LASTS THE LIST PRUNES NOTHING: a chat the
     * reader lost, in that tenant or any other, keeps its row and its offline copy until the chat's own word
     * removes it (its open read or stream says access is gone) or a complete list leaves it out. Accepted, because
     * the other way round is worse: a tenant that could not be asked is no word that its chats are gone, and
     * pruning on it would drop rows and offline copies of chats the reader still has. A row kept too long shows a
     * title; opening it asks the server, which answers for access.
     */
    complete: answers.every((answer) => answer.read),
  }
}

export const performAction = Effect.fn("Jolli.groupChat.action")(function* (
  request: GatewayRequest,
  id: Jolli.GroupChatID,
  action: Jolli.GroupChatAction,
) {
  const target = chatRequest(request, id)
  const operation =
    action.type === "cancel"
      ? { method: "POST", suffix: "/cancel", body: undefined }
      : action.type === "read"
        ? { method: "POST", suffix: "/read", body: { seq: action.seq } }
        : action.type === "target"
          ? // The server names the whole group with null, which the client's contract leaves out.
            { method: "PUT", suffix: "/composer-target", body: { assistantId: action.assistantId ?? null } }
          : action.type === "rename"
            ? { method: "PATCH", suffix: "", body: { title: action.title } }
            : action.type === "add"
              ? { method: "POST", suffix: "/participants", body: { userIds: action.userIds } }
              : { method: "DELETE", suffix: `/participants/${action.userId}`, body: undefined }
  yield* Effect.tryPromise({
    try: (signal) =>
      fetchGroupResource(target.request, target.path + operation.suffix, operation.method, operation.body, signal).then(
        (response) => response.body?.cancel(),
      ),
    catch: asError,
  })
})

export const createChat = Effect.fn("Jolli.groupChat.create")(function* (
  request: GatewayRequest,
  body: Jolli.GroupChatCreate,
) {
  const course = parseOrgScopedId(body.courseId)
  if (!course) return yield* new JolliApiError({ path: "group-chat", status: 400, message: "Invalid course ID" })
  return yield* Effect.tryPromise({
    try: async (signal) => {
      // Learned before the write, so a chat that was created is never answered as a failure.
      const org = course.org ?? (await groupHome(request, signal))
      const path = `/api/courses/${course.id}/group-chats`
      const result = Schema.decodeUnknownSync(Schema.Struct({ publicSessionId: Schema.String }))(
        await groupJson(
          await fetchGroupResource(
            scopedRequest(request, course.org),
            path,
            "POST",
            { participantIds: body.participantIds, ...(body.title ? { title: body.title } : {}) },
            signal,
          ),
          path,
        ),
      )
      return groupChatID(org, result.publicSessionId)
    },
    catch: asError,
  })
})

export const people = Effect.fn("Jolli.groupChat.people")(function* (request: GatewayRequest, courseId: string) {
  const course = parseOrgScopedId(courseId)
  if (!course) return yield* new JolliApiError({ path: "group-chat", status: 400, message: "Invalid course ID" })
  const path = `/api/courses/${course.id}/group-chats/people`
  return yield* Effect.tryPromise({
    try: async (signal) =>
      Schema.decodeUnknownSync(Schema.Array(Jolli.ChatPerson))(
        await groupJson(
          await fetchGroupResource(scopedRequest(request, course.org), path, "GET", undefined, signal),
          path,
        ),
      ),
    catch: asError,
  })
})

export const Frame = Schema.Struct({
  type: Schema.String,
  content: Schema.String.pipe(Schema.optional),
  seq: Schema.Int.pipe(Schema.optional),
  frameSeq: Schema.Int.pipe(Schema.optional),
  frames: Schema.Array(Schema.Json).pipe(Schema.optional),
  org: Org.pipe(Schema.optional),
  notification: Schema.Json.pipe(Schema.optional),
  convoId: Schema.Union([Schema.String, Schema.Int]).pipe(Schema.optional),
  code: Schema.String.pipe(Schema.optional),
  truncated: Schema.Boolean.pipe(Schema.optional),
  /** Carried by `turn_start`; frame sequences restart with every turn, so this is what tells turns apart. */
  turnId: Schema.Unknown.pipe(Schema.optional),
})
export type Frame = typeof Frame.Type
/** A frame whose other fields do not decode still keeps its type, so a control frame is never lost to them. */
export const frameOf = (value: unknown): Frame | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(Frame)(value)) ??
  (value && typeof value === "object" && "type" in value && typeof value.type === "string"
    ? { type: value.type }
    : undefined)
const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)
/**
 * How long a stream may stay silent before it is presumed dead. Every jolliedu SSE source sends a
 * keep-alive well inside this: conversation streams and @agent responses every 20 s, notification
 * streams every 30 s, the deployed Mercure hub every 30 s (40 s by Mercure's default).
 */
export const STREAM_IDLE_MS = 90_000
export const MercureConfig = Schema.Struct({ enabled: Schema.Boolean, hubUrl: Schema.NullOr(Schema.String) })
export const MercureToken = Schema.Struct({
  token: Schema.String,
  topics: Schema.Array(Schema.String),
  accessProof: Schema.String.pipe(Schema.optional),
  incomplete: Schema.Boolean.pipe(Schema.optional),
})
export const TurnBaseline = Schema.Struct({
  running: Schema.Boolean,
  frames: Schema.Array(Frame).pipe(Schema.optional),
  throughFrameSeq: Schema.Int.pipe(Schema.optional),
  truncated: Schema.Boolean.pipe(Schema.optional),
})

/**
 * Consume complete SSE records, including CRLF, multi-line data, split UTF-8 characters and named
 * events. Throws once nothing at all, not even a keep-alive comment, has arrived for `idle` ms.
 */
export async function* readFrames(response: Response, idle = STREAM_IDLE_MS): AsyncGenerator<Frame> {
  if (!response.body) return
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ""
  let timer: ReturnType<typeof setTimeout> | undefined
  // A finally, not a catch: the upstream is cancelled and its lock released however the consumer
  // leaves, including a `break` out of its loop, which throws nothing.
  try {
    while (true) {
      // A half-open connection never fails by itself: silence past the keep-alive is its only sign.
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Group chat stream went silent")), idle)
        }),
      ]).finally(() => clearTimeout(timer))
      buffer += next.value ?? ""
      let match: RegExpExecArray | null
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const lines = buffer.slice(0, match.index).split(/\r?\n/)
        buffer = buffer.slice(match.index + match[0].length)
        const event = lines
          .find((line) => line.startsWith("event:"))
          ?.slice(6)
          .trim()
        const data = lines
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n")
        if (data === "[DONE]" || (!data && !event)) continue
        const parsed = data ? Option.getOrUndefined(decodeJson(data)) : undefined
        // A named event carries its type on the event line: `session_revoked` sends only a timestamp and reason.
        const decoded = frameOf(
          event && event !== "message"
            ? { ...(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}), type: event }
            : parsed,
        )
        if (decoded) yield decoded
      }
      // Only the one record still arriving is capped: a single read may carry many complete ones.
      if (buffer.length > 2 * 1024 * 1024) throw new Error("Group chat frame exceeds the size limit")
      if (next.done) return
    }
  } finally {
    clearTimeout(timer)
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

/** Core owns the source marker, including when a caller attempts to override it. */
export async function postMessage(
  request: GatewayRequest,
  id: Jolli.GroupChatID,
  body: Jolli.GroupChatPost,
  signal?: AbortSignal,
) {
  const target = chatRequest(request, id)
  const post = Schema.decodeUnknownSync(Jolli.GroupChatPost)(body)
  // Only an agent ask answers with its turn's event stream; a plain message answers JSON in time.
  return fetchGroupResource(
    target.request,
    `${target.path}/messages`,
    "POST",
    { ...post, sentFrom: "jolli_code" },
    signal,
    post.mentionedAssistantId !== undefined,
  )
}

export function asError(cause: unknown) {
  return cause instanceof JolliApiError
    ? cause
    : new JolliApiError({ path: "group-chat", status: 500, message: "Group chat response is invalid", cause })
}
