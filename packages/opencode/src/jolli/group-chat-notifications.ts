import { Schema } from "effect"
import { JolliApiError, scopedRequest, type GatewayRequest } from "@opencode-ai/core/jolli/api"
import { JolliSignedOut } from "@opencode-ai/core/jolli/session"
import {
  MercureConfig,
  MercureToken,
  fetchGroupResource,
  groupEnvironment,
  groupJson,
  readFrames,
  type Frame,
} from "@opencode-ai/core/jolli/group-chat"
import { groupChatID, sameOrg, type OrgScope } from "@opencode-ai/core/jolli/org-scoped-id"
import { Jolli } from "@opencode-ai/schema/jolli"

/** Only the envelope identifies an event's organization; neither its stream nor topic does. */
export function notificationChat(frame: Frame, allowed: ReadonlySet<string>) {
  const org = frame.org
  if (
    !org ||
    typeof org !== "object" ||
    !("tenantSlug" in org) ||
    !("orgSlug" in org) ||
    typeof org.tenantSlug !== "string" ||
    typeof org.orgSlug !== "string"
  )
    return
  if (!allowed.has(`${org.tenantSlug}:${org.orgSlug}`)) return
  const scope = { tenantSlug: org.tenantSlug, orgSlug: org.orgSlug }
  // An id this client cannot address is dropped here; building it would throw and cost the stream the
  // frames behind it.
  const chat = (publicId: string) =>
    Schema.is(Jolli.GroupChatID)(`${scope.tenantSlug}:${scope.orgSlug}:${publicId}`)
      ? groupChatID(scope, publicId)
      : undefined
  // `chats:changed` always names the chat by its public id, a string. The frame schema admits numbers
  // only for other frames' use of the field, so a number here is ignored rather than coerced.
  if (frame.type === "chats:changed" && typeof frame.convoId === "string") {
    const id = chat(frame.convoId)
    return id ? { type: "listChanged", id } : undefined
  }
  const notice = frame.notification
  if (
    frame.type !== "notification:created" ||
    !notice ||
    typeof notice !== "object" ||
    !("type" in notice) ||
    notice.type !== "group-chat-mention" ||
    !("payload" in notice) ||
    !notice.payload ||
    typeof notice.payload !== "object" ||
    !("recordId" in notice.payload) ||
    typeof notice.payload.recordId !== "string"
  )
    return
  const id = chat(notice.payload.recordId)
  return id ? { type: "mention", id } : undefined
}

/** Nobody is signed in to Jolli, so no retry can succeed until somebody signs in. */
export function signedOut(error: unknown) {
  return (
    error instanceof JolliSignedOut ||
    (error instanceof JolliApiError && error.status === 401 && error.path === "group-chat")
  )
}

/** Wait, or stop waiting as soon as the signal aborts. */
export function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (ms <= 0 || signal.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener("abort", done, { once: true })
  })
}

/** The wait before the next attempt after `failures` attempts in a row that never opened. */
export function backoff(failures: number) {
  return Math.min(1000 * 2 ** Math.max(failures - 1, 0), 30_000)
}

/**
 * Subscribe on the org's Mercure hub. Undefined when the org has no hub or it cannot be reached,
 * which leaves the caller on the direct stream; a 401 anywhere, and a subscriber token refused with
 * 403/404, are thrown for the caller to judge.
 */
export async function openHub(request: GatewayRequest, subject: object, signal: AbortSignal) {
  const config = await fetchGroupResource(request, "/api/mercure/config", "GET", undefined, signal)
    .then(async (response) => Schema.decodeUnknownSync(MercureConfig)(await groupJson(response, "/api/mercure/config")))
    .catch((error: unknown) => {
      if (error instanceof JolliApiError && error.status === 401) throw error
      return undefined
    })
  if (!config?.enabled || !config.hubUrl) return
  const token = await fetchGroupResource(request, "/api/mercure/token", "POST", subject, signal)
    .then(async (response) => Schema.decodeUnknownSync(MercureToken)(await groupJson(response, "/api/mercure/token")))
    .catch((error: unknown) => {
      if (error instanceof JolliApiError && (error.status === 401 || error.status === 403 || error.status === 404))
        throw error
      return undefined
    })
  const url = URL.parse(config.hubUrl)
  if (!token?.topics.length || !url) return
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") return
  token.topics.forEach((topic) => url.searchParams.append("topic", topic))
  const response = await fetch(url, {
    signal,
    redirect: "error",
    headers: { Authorization: `Bearer ${token.token}`, Accept: "text/event-stream" },
  }).catch(() => undefined)
  if (response?.ok) return { response, token }
  await response?.body?.cancel()
}

export function groupChatNotifications(input: {
  request: () => Promise<GatewayRequest>
  refresh: (token: string) => Promise<unknown>
  /** `identity` keys the credential the stream that heard the event was opened with. */
  event: (type: string, identity: string, id?: Jolli.GroupChatID) => void
  /** The loop ended because nobody is signed in; whatever next finds a credential starts another. */
  signedOut: () => void
}) {
  const abort = new AbortController()
  let nudge: ReturnType<typeof setTimeout> | undefined
  // A stream that (re)opened may have missed events, so a burst of openings re-reads the list once.
  const reopened = (identity: string) => {
    clearTimeout(nudge)
    nudge = setTimeout(() => input.event("listChanged", identity), 250)
  }
  /** Renews a token the server refused; true once the credential is finished and every stream stops. */
  const finished = async (error: unknown, token: string | undefined) => {
    const outcome =
      error instanceof JolliApiError && error.status === 401 && token !== undefined
        ? await input.refresh(token).then(
            () => undefined,
            (cause: unknown) => cause,
          )
        : error
    if (!signedOut(outcome)) return false
    if (!abort.signal.aborted) {
      abort.abort()
      input.signedOut()
    }
    return true
  }
  const consume = async (response: Response, allowed: ReadonlySet<string>, identity: string) => {
    for await (const frame of readFrames(response)) {
      // The stream is about to close: the list is read again, and reconnecting decides the rest.
      if (frame.type === "session_revoked") return reopened(identity)
      const event = notificationChat(frame, allowed)
      if (event) input.event(event.type, identity, event.id)
    }
  }
  /** One org's direct stream, retried on its own so another org's failure never touches it. */
  const follow = async (org: OrgScope, home: OrgScope, allowed: ReadonlySet<string>, signal: AbortSignal) => {
    let failures = 0
    while (!signal.aborted) {
      let opened = false
      let token: string | undefined
      const error = await (async () => {
        const request = await input.request()
        token = request.token
        const response = await fetchGroupResource(
          scopedRequest(request, sameOrg(org, home) ? undefined : org),
          "/api/notifications/stream",
          "GET",
          undefined,
          signal,
        )
        opened = true
        reopened(request.identity)
        await consume(response, allowed, request.identity)
      })().then(
        () => undefined,
        (cause: unknown) => cause,
      )
      if (signal.aborted || (error !== undefined && (await finished(error, token)))) return
      failures = opened ? 0 : failures + 1
      await pause(opened ? 1000 : backoff(failures), signal)
    }
  }
  void (async () => {
    let failures = 0
    while (!abort.signal.aborted) {
      const attempt = new AbortController()
      const cancel = () => attempt.abort()
      abort.signal.addEventListener("abort", cancel, { once: true })
      // Courses change and subscriber tokens age, so the account is read again every few minutes.
      const expiry = setTimeout(cancel, 4 * 60_000)
      let retry: ReturnType<typeof setTimeout> | undefined
      let opened = false
      let token: string | undefined
      const error = await (async () => {
        const request = await input.request()
        token = request.token
        const environment = await groupEnvironment(request, attempt.signal)
        // Group chats live in course orgs, the home org included only when it has a course of its own.
        const orgs = new Map(
          environment.courses.map((course) => [`${course.org.tenantSlug}:${course.org.orgSlug}`, course.org]),
        )
        const allowed = new Set(orgs.keys())
        const hub = orgs.size
          ? await openHub(request, { type: "notifications", allOrgs: true }, attempt.signal).catch((cause: unknown) => {
              if (cause instanceof JolliApiError && cause.status === 401) throw cause
              return undefined
            })
          : undefined
        opened = true
        // No course, no group chat: nothing to follow until the account is read again.
        if (!orgs.size) return pause(5 * 60_000, attempt.signal)
        if (hub) {
          // Some org's topics are missing from this token, so another one is asked for shortly.
          if (hub.token.incomplete) retry = setTimeout(cancel, 30_000)
          reopened(request.identity)
          return consume(hub.response, allowed, request.identity)
        }
        await Promise.all([...orgs.values()].map((org) => follow(org, environment.home, allowed, attempt.signal)))
      })().then(
        () => undefined,
        (cause: unknown) => cause,
      )
      clearTimeout(expiry)
      clearTimeout(retry)
      attempt.abort()
      abort.signal.removeEventListener("abort", cancel)
      if (abort.signal.aborted) return
      if (error !== undefined && !opened && (await finished(error, token))) return
      failures = opened ? 0 : failures + 1
      await pause(opened ? 1000 : backoff(failures), abort.signal)
    }
  })()
  return () => {
    abort.abort()
    clearTimeout(nudge)
  }
}
