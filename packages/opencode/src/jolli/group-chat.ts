import { backoff, groupChatNotifications, openHub, pause, signedOut } from "./group-chat-notifications"
import type { GroupChatCache } from "@opencode-ai/core/jolli/group-chat-cache"
import { parseGroupChatID } from "@opencode-ai/core/jolli/org-scoped-id"
import { Effect, Schema } from "effect"
import { Jolli } from "@opencode-ai/schema/jolli"
import { JolliApiError, type GatewayRequest } from "@opencode-ai/core/jolli/api"
import { JolliSession, onJolliSessionChanged } from "@opencode-ai/core/jolli/session"
import {
  frameOf,
  TurnBaseline,
  chatRequest,
  fetchGroupResource,
  groupJson,
  postMessage,
  readFrames,
  type Frame,
} from "@opencode-ai/core/jolli/group-chat"
import { GlobalBus } from "@/bus/global"

type Watch = {
  identity: string
  id: Jolli.GroupChatID
  clients: Set<string>
  abort: AbortController
  relay?: AbortController
  /** An @agent ask of ours is out: its own response stream relays the turn, and the subscription keeps quiet. */
  sending: boolean
  /** The turn our last ask opened, which its response stream relays rather than the subscription. */
  ownTurn?: unknown
  /** Join the running turn again on the live subscription; `release` runs the moment that join takes over. */
  rejoin?: (release: () => void) => Promise<void>
  revoked?: boolean
  timer?: ReturnType<typeof setTimeout>
}
const watches = new Map<string, Watch>()
const clients = new Map<string, Set<string>>()
let session: JolliSession.Interface | undefined
let activeIdentity: string | undefined
let cache: GroupChatCache | undefined
let sessionChanged: (() => void) | undefined
const readers = new Set<string>()
let stopNotifications: (() => void) | undefined
function ensureNotifications() {
  if (stopNotifications || !clients.size || !session) return
  const current = session
  const stop = groupChatNotifications({
    request: currentGroupChatRequest,
    refresh: (token) => Effect.runPromise(current.refused(token)),
    event: (type, chatID) => emit(type, chatID ? { chatID } : {}),
    signedOut: () => {
      if (stopNotifications === stop) stopNotifications = undefined
    },
  })
  stopNotifications = stop
}

export function configureGroupChats(value: JolliSession.Interface, storage?: GroupChatCache) {
  session = value
  activeIdentity = undefined
  cache = storage
  sessionChanged?.()
  sessionChanged = onJolliSessionChanged(() => {
    for (const watch of [...watches.values()]) dispose(watch)
    stopNotifications?.()
    stopNotifications = undefined
    emit("reset", {})
    readers.clear()
    activeIdentity = undefined
  })
}
export function groupChatAccess(id: Jolli.GroupChatID, access: Jolli.GroupChat["access"]) {
  if (access === "reader") readers.add(id)
  else readers.delete(id)
}

/** Leases belong to the event connection, so a crashed window cannot strand a subscription. */
export function connectGroupChatClient(id: string | undefined) {
  if (!id) return () => {}
  const previous = clients.get(id)
  if (previous)
    for (const key of previous) {
      const watch = watches.get(key)
      watch?.clients.delete(id)
      if (watch && !watch.clients.size) {
        watch.relay?.abort()
        if (!watch.sending) dispose(watch)
      }
    }
  const owned = new Set<string>()
  clients.set(id, owned)
  ensureNotifications()
  return () => {
    if (clients.get(id) !== owned) return
    clients.delete(id)
    if (!clients.size) {
      stopNotifications?.()
      stopNotifications = undefined
    }
    for (const key of owned) {
      const watch = watches.get(key)
      watch?.clients.delete(id)
      if (watch && !watch.clients.size) {
        watch.relay?.abort()
        if (!watch.sending) dispose(watch)
      }
    }
  }
}

export async function currentGroupChatRequest(): Promise<GatewayRequest> {
  const request = session ? await Effect.runPromise(session.request()) : undefined
  // A credential with no tenant has no gateway to reach: unreachable, as the course routes answer, not signed out.
  if (!request && session && (await Effect.runPromise(session.current())))
    throw new JolliApiError({ path: "group-chat", message: "The Jolli credential names no gateway" })
  if (!request) {
    if (activeIdentity) {
      activeIdentity = undefined
      for (const watch of [...watches.values()]) dispose(watch)
      stopNotifications?.()
      stopNotifications = undefined
      emit("reset", {})
    }
    throw new JolliApiError({ path: "group-chat", status: 401, message: "Sign in to Jolli" })
  }
  const switched = activeIdentity !== undefined && activeIdentity !== request.identity
  activeIdentity = request.identity
  for (const watch of [...watches.values()]) if (watch.identity !== request.identity) dispose(watch)
  if (switched) {
    stopNotifications?.()
    stopNotifications = undefined
    readers.clear()
    emit("reset", {})
    throw new JolliApiError({
      path: "group-chat",
      status: 409,
      code: "account_changed",
      message: "The active Jolli account changed",
    })
  }
  return request
}

export async function withGroupChatAuth<A>(run: (request: GatewayRequest) => Promise<A>) {
  const request = await currentGroupChatRequest()
  ensureNotifications()
  try {
    return await run(request)
  } catch (error) {
    if (!(error instanceof JolliApiError) || error.status !== 401 || !session) throw error
    await Effect.runPromise(session.refused(request.token))
    return run(await currentGroupChatRequest())
  }
}

function emit(type: string, properties: object) {
  GlobalBus.emit("event", { directory: "global", payload: { type: `jolli.groupChat.${type}`, properties } })
}
function warn(message: string, error: unknown) {
  Effect.runFork(Effect.logWarning(message, { error }))
}
function keyOf(watch: Pick<Watch, "identity" | "id">) {
  return JSON.stringify([watch.identity, watch.id])
}
function dispose(watch: Watch) {
  watch.abort.abort()
  clearTimeout(watch.timer)
  if (watches.get(keyOf(watch)) === watch) {
    watches.delete(keyOf(watch))
    for (const client of watch.clients) clients.get(client)?.delete(keyOf(watch))
  }
}
function changed(watch: Watch) {
  clearTimeout(watch.timer)
  // An ask of ours ends with one refresh of its own, which covers whatever happened meanwhile.
  if (watch.sending) return
  watch.timer = setTimeout(() => {
    if (!watch.sending) emit("changed", { chatID: watch.id })
  }, 150)
}
async function revoked(watch: Watch) {
  if (watch.revoked) return
  watch.revoked = true
  dispose(watch)
  // The offline copy goes before anyone hears of the revocation, so nothing reads it afterwards.
  await cache
    ?.remove(watch.identity, watch.id)
    .catch((error: unknown) => warn("Group chat: could not purge a revoked chat's offline copy", error))
  emit("revoked", { chatID: watch.id })
}
function membershipChanged(watch: Watch) {
  // Not served offline again until a read confirms the new membership.
  void (cache?.unconfirm(watch.identity, watch.id) ?? Promise.resolve())
    .catch((error: unknown) => warn("Group chat: could not mark an offline copy unconfirmed", error))
    .then(() => changed(watch))
}
/** Only these refusals mean access is gone; a 403 that asks for SSO sign-in does not. */
function revocation(error: unknown, accessCheck = false) {
  if (!(error instanceof JolliApiError) || error.code === "sso_required") return false
  return error.status === 403 || (error.status === 404 && (!accessCheck || error.code === "conversation_access_revoked"))
}

const terminal = new Set(["processing_complete", "message_complete", "cancelled", "error", "agent_turn_orphaned"])
const turnStarts = new Set(["message_received", "typing", "turn_start"])
/** Relay answer text; a frame that starts a turn, or a catch-up (`truncated` given), clears the bubble first. */
function forward(watch: Watch, frame: Frame, truncated?: boolean) {
  if (readers.has(watch.id)) return
  const reset = truncated !== undefined || turnStarts.has(frame.type)
  if (!reset && frame.type !== "content_chunk") return
  emit("answer", {
    chatID: watch.id,
    type: frame.type,
    ...(typeof frame.content === "string" ? { content: frame.content } : {}),
    ...(typeof frame.seq === "number" ? { seq: frame.seq } : {}),
    ...(typeof frame.frameSeq === "number" ? { frameSeq: frame.frameSeq } : {}),
    ...(reset ? { reset: true, truncated: truncated === true } : {}),
  })
}

export async function watchGroupChat(id: Jolli.GroupChatID, clientID: string, active: boolean) {
  const request = await currentGroupChatRequest()
  const key = JSON.stringify([request.identity, id])
  const owned = clients.get(clientID)
  if (!owned) return false
  const existing = watches.get(key)
  if (!active) {
    owned.delete(key)
    existing?.clients.delete(clientID)
    if (existing && !existing.clients.size) {
      existing.relay?.abort()
      if (!existing.sending) dispose(existing)
    }
    return true
  }
  owned.add(key)
  if (existing) {
    existing.clients.add(clientID)
    if (!existing.relay || existing.relay.signal.aborted) void subscribe(existing)
    return true
  }
  const watch: Watch = {
    identity: request.identity,
    id,
    clients: new Set([clientID]),
    abort: new AbortController(),
    sending: false,
  }
  watches.set(key, watch)
  void subscribe(watch)
  return true
}

/** The running turn so far; "refused" when the server will not let us join it, "failed" when it could not say. */
async function turnBaseline(watch: Watch, signal: AbortSignal) {
  return withGroupChatAuth(async (request) => {
    const target = chatRequest(request, watch.id)
    const path = `${target.path}/turn-baseline`
    return Schema.decodeUnknownSync(TurnBaseline)(
      await groupJson(await fetchGroupResource(target.request, path, "GET", undefined, signal), path),
    )
  }).catch((error: unknown) => {
    if (!(error instanceof JolliApiError) || (error.status !== 403 && error.status !== 404)) return "failed" as const
    // Only participants join a running turn: the server just said this viewer reads the chat.
    if (error.code === "not_allowed") readers.add(watch.id)
    return "refused" as const
  })
}

async function subscribe(watch: Watch) {
  const relay = new AbortController()
  watch.relay = relay
  const signal = AbortSignal.any([watch.abort.signal, relay.signal])
  let failures = 0
  let streak = 0
  while (!signal.aborted) {
    const started = Date.now()
    const outcome = await connect(watch, signal)
    if (outcome === "stop" || signal.aborted) return
    failures = outcome === "failed" ? failures + 1 : 0
    // A reconnect the server asked for is immediate, unless new connections keep being turned away at once.
    streak = outcome !== "reconnect" ? 0 : Date.now() - started < 10_000 ? streak + 1 : 1
    await pause(outcome === "failed" ? backoff(failures) : outcome === "reconnect" && streak <= 3 ? 0 : 1000, signal)
  }
}

/** One upstream connection: open it, join the running turn, and relay until it ends. */
async function connect(watch: Watch, signal: AbortSignal) {
  const attempt = new AbortController()
  const cancel = () => attempt.abort()
  signal.addEventListener("abort", cancel, { once: true })
  let check: ReturnType<typeof setInterval> | undefined
  let opened = false
  let requested = false
  let token: string | undefined
  // Frames wait here while a turn baseline is fetched, then are reconciled against it.
  let hold: Frame[] | undefined = []
  let turn: unknown
  // The last frame sequence of `turn` already relayed, by the baseline or live: frames still in flight when the
  // baseline lands repeat it.
  let through = 0
  let joins = 0
  const reconnect = () => {
    requested = true
    attempt.abort()
  }
  const quiet = () => watch.sending || (turn !== undefined && turn === watch.ownTurn)
  const follow = (frame: Frame) => {
    // Frame sequences restart with every turn, so a new ask or another turn's start resets the watermark.
    if (frame.type === "typing" || (frame.type === "turn_start" && frame.turnId !== turn)) through = 0
    if (frame.type === "typing") turn = undefined
    if (frame.type === "turn_start") turn = frame.turnId
    if (typeof frame.frameSeq === "number" && frame.frameSeq <= through) return
    if (typeof frame.frameSeq === "number") through = frame.frameSeq
    if (terminal.has(frame.type)) changed(watch)
    if (!quiet()) forward(watch, frame)
  }
  const join = async (release?: () => void) => {
    const generation = ++joins
    hold ??= []
    const data = readers.has(watch.id) ? "refused" : await turnBaseline(watch, attempt.signal)
    if (generation !== joins || attempt.signal.aborted) return
    release?.()
    const held = hold ?? []
    hold = undefined
    const running = data !== "refused" && data !== "failed" && data.running ? data : undefined
    turn = running?.frames?.find((frame) => frame.type === "turn_start")?.turnId
    through = running?.throughFrameSeq ?? 0
    if (data === "refused") {
      // Readers follow the record, not a running turn: what arrives only says when to read it again.
      held.forEach(follow)
      return changed(watch)
    }
    if (!quiet()) {
      // A catch-up that is a prefix, or none at all, must not pass for the whole answer.
      forward(watch, { type: "baseline" }, data === "failed" || data.truncated === true)
      if (running && !running.truncated) running.frames?.forEach((frame) => forward(watch, frame))
    }
    // Everything held before the joined turn's own start is in the baseline or belongs to an earlier turn; a
    // typing frame there is that turn's, and replaying it would wipe the catch-up.
    const start =
      turn === undefined ? -1 : held.findIndex((frame) => frame.type === "turn_start" && frame.turnId === turn)
    held.forEach((frame, index) => {
      if (index > start) follow(frame)
    })
    changed(watch)
  }
  const rejoin = (release: () => void) => join(release)
  try {
    const request = await currentGroupChatRequest()
    if (request.identity !== watch.identity) return "stop"
    token = request.token
    const target = chatRequest(request, watch.id)
    const publicId = parseGroupChatID(watch.id).publicId
    const hub = await openHub(target.request, { type: "convo", id: publicId }, attempt.signal)
    if (hub && hub.token.topics.length !== 1) throw new Error("A conversation subscription must have one topic")
    const response =
      hub?.response ?? (await fetchGroupResource(target.request, `${target.path}/stream`, "GET", undefined, attempt.signal))
    opened = true
    const receive = (frame: Frame): void => {
      if (attempt.signal.aborted) return
      if (frame.type === "conversation_frames") {
        for (const item of frame.frames ?? []) {
          const decoded = frameOf(item)
          if (decoded) receive(decoded)
        }
        return
      }
      if (frame.type === "session_revoked") {
        void revoked(watch)
        return
      }
      // The hub moved this conversation to a new topic or lost its place: subscribe again and re-join.
      if (frame.type === "conversation_access_changed" || frame.type === "conversation_stream_reset") return reconnect()
      if (frame.type === "membership_changed") {
        membershipChanged(watch)
        // A hub topic belongs to one membership epoch, so the new membership needs a new subscription.
        if (hub) reconnect()
        return
      }
      if (frame.type === "group_message_added") return changed(watch)
      if (hold) {
        hold.push(frame)
        return
      }
      follow(frame)
    }
    if (hub?.token.accessProof) {
      // The token can be minted for a topic that rotates before the hub subscribes, so the topic is checked
      // once open and again every 30 s.
      const access = { id: publicId, topic: hub.token.topics[0], proof: hub.token.accessProof }
      const verify = () =>
        void withGroupChatAuth(async (fresh) =>
          Schema.decodeUnknownSync(Schema.Struct({ current: Schema.Boolean }))(
            await groupJson(
              await fetchGroupResource(
                chatRequest(fresh, watch.id).request,
                "/api/mercure/conversation-access",
                "POST",
                access,
                attempt.signal,
              ),
              "/api/mercure/conversation-access",
            ),
          ),
        )
          .then((result) => {
            if (!result.current) reconnect()
          })
          .catch((error: unknown) => {
            if (attempt.signal.aborted) return
            if (revocation(error, true)) return void revoked(watch)
            if (error instanceof JolliApiError && error.code === "sso_required") changed(watch)
            // A check that could not be made says nothing about access, so the stream carries on.
            warn("Group chat: could not verify conversation access", error)
          })
      verify()
      check = setInterval(verify, 30_000)
    }
    watch.rejoin = rejoin
    const drain = (async () => {
      for await (const frame of readFrames(response)) receive(frame)
    })()
    // Once the stream is over, a baseline still in flight has nothing left to join.
    void drain.catch(() => undefined).finally(cancel)
    await join()
    await drain
    return "opened"
  } catch (error) {
    if (signal.aborted) return "stop"
    if (requested) return "reconnect"
    if (revocation(error)) {
      await revoked(watch)
      return "stop"
    }
    // An SSO sign-in the server wants is no loss of access: the renderer reads the chat to learn what it is.
    if (error instanceof JolliApiError && error.code === "sso_required") changed(watch)
    const refusal =
      error instanceof JolliApiError && error.status === 401 && token !== undefined && session
        ? await Effect.runPromise(session.refused(token)).then(
            () => undefined,
            (cause: unknown) => cause,
          )
        : error
    if (signedOut(refusal)) return "stop"
    return opened ? "opened" : "failed"
  } finally {
    clearInterval(check)
    attempt.abort()
    signal.removeEventListener("abort", cancel)
    if (watch.rejoin === rejoin) watch.rejoin = undefined
  }
}

/** Return on admission, while one background reader owns the sender's SSE until it settles. */
export async function sendGroupChatMessage(id: Jolli.GroupChatID, body: Jolli.GroupChatPost): Promise<void> {
  const request = await currentGroupChatRequest()
  const key = JSON.stringify([request.identity, id])
  if (body.mentionedAssistantId === undefined) {
    // A plain message answers with JSON in time: no stream to follow and no ask to keep track of.
    await withGroupChatAuth(async (fresh) => {
      const response = await postMessage(fresh, id, body, AbortSignal.timeout(30_000))
      await response.body?.cancel()
    })
    const watch = watches.get(key)
    if (watch) changed(watch)
    else emit("changed", { chatID: id })
    return
  }
  const watch = watches.get(key) ?? {
    identity: request.identity,
    id,
    clients: new Set<string>(),
    abort: new AbortController(),
    sending: false,
  }
  watches.set(key, watch)
  if (watch.sending)
    throw new JolliApiError({
      path: "group-chat",
      status: 409,
      code: "agent_busy",
      message: "An agent is already answering",
    })
  watch.sending = true
  clearTimeout(watch.timer)
  return new Promise<void>((resolve, reject) => {
    let accepted = false
    let ended = false
    const admission = new AbortController()
    const timer = setTimeout(() => {
      if (accepted) return
      admission.abort()
      reject(new JolliApiError({ path: "group-chat", message: "Message admission timed out" }))
    }, 30_000)
    void (async () => {
      try {
        const response = await withGroupChatAuth((fresh) =>
          postMessage(fresh, id, body, AbortSignal.any([watch.abort.signal, admission.signal])),
        )
        if (!response.headers.get("content-type")?.includes("text/event-stream")) {
          await response.body?.cancel()
          accepted = true
          resolve()
          return
        }
        for await (const frame of readFrames(response)) {
          if (frame.type === "message_received") {
            accepted = true
            clearTimeout(timer)
            resolve()
          }
          if (frame.type === "error" && !accepted)
            // A refusal is never "no answer": one without a code still reads as refused, so the
            // composer frees the request id instead of keeping it for a retry of a lost send.
            throw new JolliApiError({
              path: "group-chat",
              code: typeof frame.code === "string" ? frame.code : "message_refused",
              message: "Message was refused",
            })
          if (frame.type === "turn_start") watch.ownTurn = frame.turnId
          forward(watch, frame)
          if (terminal.has(frame.type)) ended = true
        }
        if (!accepted) throw new JolliApiError({ path: "group-chat", message: "Message admission was not confirmed" })
      } catch (error) {
        if (!accepted) reject(error)
      } finally {
        clearTimeout(timer)
        const settle = () => {
          watch.sending = false
          if (!ended) watch.ownTurn = undefined
        }
        // Refused, or cut off before its end: whatever turn runs now, ours or someone else's, is joined again
        // on the subscription, which stays quiet until that join takes over.
        if (!ended && watch.rejoin && !watch.abort.signal.aborted)
          await watch.rejoin(settle).catch((error: unknown) => warn("Group chat: could not re-join a turn", error))
        settle()
        clearTimeout(watch.timer)
        if (!watch.revoked) emit("changed", { chatID: id })
        if (!watch.clients.size) dispose(watch)
      }
    })()
  })
}
