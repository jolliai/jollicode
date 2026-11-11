import { Effect, Option, Schema } from "effect"
import { Jolli } from "@opencode-ai/schema/jolli"
import { JolliApiError, scopedRequest, type GatewayRequest } from "./api"
import { readCatalog } from "./cache"
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
 * What a failed group chat call means to the renderer.
 *
 * Only the chat's own open read can say that access to the chat is gone (`revoked`), and not when it
 * asks for the school's sign-in (`sso_required`). Any other 4xx — an action, a post, or a request an
 * open makes on the side — refuses that one request. `opened` names the chat when the failure came
 * from opening it.
 */
export function groupChatFailure(error: unknown, opened?: Jolli.GroupChatID): Jolli.GroupChatAnswer {
  if (error instanceof Error && "_tag" in error && error._tag === "Jolli.SignedOut") return { status: "signed-out" }
  if (!(error instanceof JolliApiError)) return { status: "unreachable" }
  const code = error.code === undefined ? {} : { code: error.code }
  if (error.status === undefined)
    return error.code === undefined ? { status: "unreachable" } : { status: "refused", ...code }
  if (error.status === 401) return { status: "signed-out", httpStatus: 401 }
  if (error.status < 400 || error.status >= 500) return { status: "unreachable", ...code }
  const lost =
    opened !== undefined &&
    (error.status === 403 || error.status === 404) &&
    error.code !== "sso_required" &&
    error.path === `${chatPath(opened)}/open`
  const message = error.explanation && error.explanation !== error.code ? { message: error.explanation } : {}
  return { status: lost ? "revoked" : "refused", ...code, httpStatus: error.status, ...message }
}

const Org = Schema.Struct({ tenantSlug: Schema.String, orgSlug: Schema.String })
const homes = new Map<string, OrgScope>()
const viewers = new Map<string, number>()

/** The home org from memory or the catalogue snapshot on disk, never from the network. */
export async function knownGroupHome(request: GatewayRequest) {
  const key = environmentKey(request)
  const known = homes.get(key)
  if (known) return known
  const snapshot = await Effect.runPromise(readCatalog(request))
  if (!snapshot?.home) return undefined
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

/** The chat's own open read: the one request whose 403/404 means access to the chat is gone. */
export async function readChatOpen(request: GatewayRequest, id: Jolli.GroupChatID, signal?: AbortSignal) {
  const target = chatRequest(request, id)
  const path = `${target.path}/open`
  const opened = Schema.decodeUnknownSync(Opened)(
    await groupJson(await fetchGroupResource(target.request, path, "GET", undefined, signal), path),
  )
  const detail = "detail" in opened ? opened.detail : opened.transcript
  if (detail.kind !== "group") throw new JolliApiError({ path, status: 404, message: "Group chat not found" })
  return { target, access: opened.access, detail }
}

export const openChat = Effect.fn("Jolli.groupChat.open")(function* (
  request: GatewayRequest,
  id: Jolli.GroupChatID,
  subject?: string | null,
) {
  return yield* Effect.tryPromise({
    try: async (signal) => {
      // Needed to address the chat and name its course, yet never a reason the chat cannot open.
      // The home, open and viewer reads run in turn: after the first open the home comes from memory or
      // the catalogue on disk and the viewer from the credential's subject or memory, so the open read
      // is the only one that waits on the network.
      const home = await groupHome(request, signal).catch(() => undefined)
      const opened = await readChatOpen(request, id, signal)
      const scope = parseGroupChatID(id).scope
      const spaceId = opened.detail.spaceId
      return {
        id,
        viewerId: await groupViewer(request, subject, signal),
        webBaseUrl: `${request.origin}/t/${encodeURIComponent(scope.tenantSlug)}/o/${encodeURIComponent(scope.orgSlug)}`,
        title: opened.detail.title ?? "",
        // Without a known home a home course comes out scoped ("t:o:42") where the catalogue and the
        // chat list name it "42". The scoped form still names the course exactly, so the composer's
        // assistant address and reference reads keep working; "" would leave no assistant address at
        // all. The next open with the home known rewrites the cached copy, and an unscoped list
        // reconcile drops it if the chat is gone.
        courseId:
          spaceId === undefined || spaceId === null
            ? ""
            : orgScopedId(sameOrg(scope, home) ? undefined : scope, spaceId),
        access: opened.access,
        processing: opened.access === "reader" ? false : (opened.detail.runtime?.isProcessing ?? false),
        locked: opened.detail.governance?.locked ?? false,
        shareBlocked: opened.detail.governance?.shareBlocked ?? false,
        group: opened.detail.group,
        messages: opened.detail.timeline.flatMap((item) =>
          Schema.is(MessageItem)(item) ? [Schema.decodeUnknownSync(Jolli.ChatMessage)(item)] : [],
        ),
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
export async function groupEnvironment(request: GatewayRequest, signal?: AbortSignal) {
  const result = Schema.decodeUnknownSync(GroupEnvironment)(
    await groupJson(await fetchGroupResource(request, "/api/me/courses", "GET", undefined, signal), "/api/me/courses"),
  )
  homes.set(environmentKey(request), result.home)
  return { home: result.home, courses: result.courses, unavailable: result.unavailable ?? [] }
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
      const environment = await groupEnvironment(request, signal)
      const tenants = new Map(environment.courses.map((course) => [course.org.tenantSlug, course.org]))
      const enabled = new Set<string>()
      let complete = courses !== undefined && environment.unavailable.length === 0
      // One tenant at a time: there is one entry per school the student's courses belong to, usually a
      // single one, so a parallel fan-out would save next to nothing.
      for (const org of tenants.values()) {
        try {
          const config = Schema.decodeUnknownSync(
            Schema.Struct({ groupChatsEnabled: Schema.Boolean.pipe(Schema.optional) }),
          )(
            await groupJson(
              await fetchGroupResource(
                scopedRequest(request, sameOrg(org, environment.home) ? undefined : org),
                "/api/auth/session-config",
                "GET",
                undefined,
                signal,
              ),
              "/api/auth/session-config",
            ),
          )
          if (config.groupChatsEnabled === true) enabled.add(org.tenantSlug)
        } catch (error) {
          if (!(error instanceof JolliApiError && error.status === 404)) complete = false
        }
      }
      const enabledCourseIds = environment.courses
        .filter((course) => enabled.has(course.org.tenantSlug))
        .map((course) => orgScopedId(sameOrg(course.org, environment.home) ? undefined : course.org, course.id))
      const result: Jolli.GroupChatSummary[] = []
      let cursor: string | undefined
      let pages = 0
      const cursors = new Set<string>()
      do {
        const path = `/api/me/agent-convos?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`
        const page = Schema.decodeUnknownSync(ChatPage)(
          await groupJson(await fetchGroupResource(request, path, "GET", undefined, signal), path),
        )
        if (page.unavailable.length) complete = false
        for (const row of page.convos) {
          if (row.kind !== "group" || !enabled.has(row.org.tenantSlug)) continue
          // One id this client cannot address is skipped rather than failing the whole list. The list
          // stays complete: such a chat can never have an offline copy for the purge to keep.
          if (!Schema.is(Jolli.GroupChatID)(`${row.org.tenantSlug}:${row.org.orgSlug}:${row.id}`)) continue
          const space = row.courseSpaceId ?? row.spaceId
          const candidate =
            space === undefined ? "" : orgScopedId(sameOrg(row.org, environment.home) ? undefined : row.org, space)
          const knownCourseId =
            courses === undefined || courses.some((course) => course.id === candidate) ? candidate : ""
          if (courseId && knownCourseId !== courseId) continue
          result.push({
            id: groupChatID(row.org, row.id),
            title: row.title ?? "",
            courseId: knownCourseId,
            courseCode: row.courseCode ?? "",
            updatedAt: row.updatedAt,
            participantCount: row.participantCount ?? 0,
            unreadCount: row.unreadCount ?? 0,
            processing: row.isProcessing ?? false,
            ownership: row.ownership,
          })
        }
        cursor = page.nextCursor
        if (cursor && cursors.has(cursor)) throw new Error("Repeated group chat cursor")
        if (cursor) cursors.add(cursor)
        pages += 1
        // The pages also hold direct chats, so a student with many of them could page on for every
        // refresh. Past the cap the list is reported incomplete, which purges nothing.
      } while (cursor && result.length < 64 && pages < LIST_PAGE_LIMIT)
      return { chats: result.slice(0, 64), complete: complete && !cursor && result.length <= 64, enabledCourseIds }
    },
    catch: asError,
  })
})

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
          ? { method: "PUT", suffix: "/composer-target", body: { assistantId: action.assistantId } }
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
      if (buffer.length > 2 * 1024 * 1024) throw new Error("Group chat frame exceeds the size limit")
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
