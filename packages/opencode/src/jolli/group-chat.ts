import { backoff, groupChatNotifications, openHub, pause, signedOut } from "./group-chat-notifications"
import { groupChatOwner, type GroupChatCache } from "@opencode-ai/core/jolli/group-chat-cache"
import { parseGroupChatID } from "@opencode-ai/core/jolli/org-scoped-id"
import { Effect, Schema } from "effect"
import { Jolli } from "@opencode-ai/schema/jolli"
import { JolliApiError, type GatewayRequest } from "@opencode-ai/core/jolli/api"
import { JolliSession, onJolliSessionChanged, type JolliSessionChange } from "@opencode-ai/core/jolli/session"
import {
  accessRevoked,
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
/*
 * ⚠ MODULE STATE ON PURPOSE. One sidecar process serves one signed-in account, and what this bridge emits
 * goes to `GlobalBus`, which is process-wide too, so a second bridge in the same process would only
 * double every event. `configureGroupChats` runs when the jolli handlers are built and hands over the
 * session and cache; building them again (as tests do) replaces both and subscribes to session changes once.
 */
const watches = new Map<string, Watch>()
const clients = new Map<string, Set<string>>()
let session: JolliSession.Interface | undefined
/**
 * The credential whose streams this bridge follows (its key) and the person it signs in (`groupChatOwner`), whom
 * the renderer was last settled against. In memory only, and forgotten whenever the credential goes away.
 */
let known: { identity: string; owner: string } | undefined
/** Credential changes are settled one at a time, so a sign-in and a request that meets it never both decide. */
let settling: Promise<unknown> = Promise.resolve()
/** What the streams heard, relayed one event at a time (see `relay`). */
let relaying: Promise<unknown> = Promise.resolve()
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
    event: (type, identity, chatID) => relay(identity, type, chatID ? { chatID } : {}),
    signedOut: () => {
      if (stopNotifications === stop) stopNotifications = undefined
    },
  })
  stopNotifications = stop
}

export function configureGroupChats(value: JolliSession.Interface, storage?: GroupChatCache) {
  // A notification loop started under the previous session would keep asking with it.
  stopNotifications?.()
  stopNotifications = undefined
  session = value
  known = undefined
  cache = storage
  sessionChanged?.()
  sessionChanged = onJolliSessionChanged(credentialChanged)
}
export function groupChatAccess(id: Jolli.GroupChatID, access: Jolli.GroupChat["access"]) {
  if (access === "reader") {
    readers.add(id)
    return
  }
  readers.delete(id)
}

/**
 * ⚠ A CREDENTIAL THAT GOES AWAY TAKES EVERY GROUP CHAT ON SCREEN WITH IT. A sign-out, a credential that could not
 * be renewed, and one another process removed (noticed on the next request) all answer a plain `reset`, which
 * drops the renderer's rows, tabs and drafts. Only a sign-in over a credential of the same person, one this
 * process followed until then, keeps them (`reset { sameAccount }`): the streams restart under the new token.
 * Anybody else, or anything this process cannot tell, is a plain reset.
 */
function credentialChanged(change: JolliSessionChange) {
  if (change !== "signed-in") return lose()
  const current = session
  stopStreams()
  settling = settling
    .then(async () => {
      const row = current ? await Effect.runPromise(current.current()).catch(() => undefined) : undefined
      if (current !== session) return
      // Gone again already: whoever removed it took the renderer's chats with it.
      if (!row) return lose()
      const owner = groupChatOwner(row)
      // `store.persist` keeps a credential's key only when the same person signs in over it while it is stored,
      // so the key this process followed is the proof that nothing went away in between.
      const same = known?.identity === row.cache_key && known.owner === owner
      known = { identity: row.cache_key, owner }
      if (!same) readers.clear()
      emit("reset", same ? { sameAccount: true } : {})
    })
    // A settlement that failed cannot tell whose chats are on screen. It never leaves `settling` rejected,
    // which every request waits on.
    .catch(() => lose())
}

/** The credential went away: everything it followed stops, and the renderer drops every group chat it holds. */
function lose() {
  known = undefined
  stopStreams()
  readers.clear()
  emit("reset", {})
}

function stopStreams() {
  for (const watch of [...watches.values()]) dispose(watch)
  stopNotifications?.()
  stopNotifications = undefined
}

/**
 * ⚠ A STREAM SPEAKS FOR THE CREDENTIAL IT WAS OPENED WITH, AND ANOTHER PROCESS (THE CLI, THE TUI) CAN SIGN THAT ONE
 * OUT, OR SIGN SOMEBODY ELSE IN OVER IT, WITHOUT THIS ONE HEARING OF IT. A conversation stream runs on until its
 * next request notices (up to 30 s on a hub) and the notification stream up to four minutes, and a mention it
 * relays becomes a system notification naming the previous person's chat. So nothing a stream hears reaches the
 * renderer before a read of the store (local, no network) finds that credential still the active one. Answer text
 * is checked too, one read per frame. One chain for every stream keeps the events in the order they arrived.
 */
function relay(identity: string, type: string, properties: object) {
  relaying = relaying
    .then(async () => {
      if (await following(identity)) emit(type, properties)
    })
    .catch((error: unknown) => warn("Group chat: could not relay an event", error))
}

/**
 * Whether `identity` keys the credential this bridge follows and the store still holds as the active one. When the
 * store holds another one or none, the bridge settles as the next request would: no credential loses everything,
 * another one replaces the followed one (a plain reset either way, since this process did not see it happen).
 */
async function following(identity: string) {
  const current = session
  // A stream of a credential the bridge has already moved past is being stopped.
  if (!current || identity !== known?.identity) return false
  // A store that could not be read says nothing about who is signed in: the event is dropped, and nothing settled.
  const row = await Effect.runPromise(current.current()).catch(() => null)
  if (row === null) return false
  if (row?.cache_key === identity) return true
  settling = settling
    .then(async () => {
      // Settled once, by whichever of the streams, a request or a sign-in got there first.
      if (current !== session || known?.identity !== identity) return
      const latest = await Effect.runPromise(current.current())
      if (latest?.cache_key === identity) return
      if (!latest) return lose()
      known = { identity: latest.cache_key, owner: groupChatOwner(latest) }
      stopStreams()
      readers.clear()
      emit("reset", {})
    })
    // A store that could not be read here settles nothing: the next request decides. `settling` never stays rejected.
    .catch(() => undefined)
  return false
}

/** Leases belong to the event connection, so a crashed window cannot strand a subscription. */
export function connectGroupChatClient(id: string | undefined) {
  if (!id) return () => {}
  const previous = clients.get(id)
  if (previous) releaseLeases(id, previous)
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
    releaseLeases(id, owned)
  }
}

/** A client stops following these chats; a chat nobody follows any more closes its subscription. */
function releaseLeases(client: string, keys: Iterable<string>) {
  for (const key of keys) {
    const watch = watches.get(key)
    if (!watch) continue
    watch.clients.delete(client)
    if (watch.clients.size) continue
    watch.relay?.abort()
    // An ask still out keeps its watch: the ask disposes it once it settles.
    if (!watch.sending) dispose(watch)
  }
}

export async function currentGroupChatRequest(): Promise<GatewayRequest> {
  await settling
  const current = session
  const request = current ? await Effect.runPromise(current.request()) : undefined
  // A credential with no tenant has no gateway to reach: unreachable, as the course routes answer, not signed out.
  if (!request && current && (await Effect.runPromise(current.current())))
    throw new JolliApiError({ path: "group-chat", message: "The Jolli credential names no gateway" })
  if (!request) {
    // Signed out, but nobody said so here: another process signed out, or let the credential lapse. Said once,
    // for the credential this bridge followed; a renderer asking again while signed out hears only its answer.
    if (known) lose()
    throw new JolliApiError({ path: "group-chat", status: 401, message: "Sign in to Jolli" })
  }
  if (current && request.identity !== known?.identity) {
    const adopted = settling.then(() => adopt(current, request))
    settling = adopted.catch(() => undefined)
    await adopted
  }
  for (const watch of [...watches.values()]) if (watch.identity !== request.identity) dispose(watch)
  return request
}

/**
 * A request under a credential this bridge does not follow yet. The first since this process started, or since
 * the last one went away, is adopted as it is: what the renderer held was dropped when that one went, and each
 * window checks a list's `owner` against the chats it holds besides. Any other replaced the followed credential
 * in another process, so the followed one went away there: a plain reset, and a request that met somebody else
 * is refused as well, so nothing of theirs reaches a screen still showing the previous person's chats.
 */
async function adopt(current: JolliSession.Interface, request: GatewayRequest) {
  if (request.identity === known?.identity) return
  const row = await Effect.runPromise(current.current())
  // The credential moved between the two reads: the next request finds out whose it is.
  if (row?.cache_key !== request.identity)
    throw new JolliApiError({ path: "group-chat", message: "The Jolli credential changed while it was read" })
  const previous = known
  known = { identity: row.cache_key, owner: groupChatOwner(row) }
  // While this bridge followed nothing, everything older was already stopped, and what runs was started for
  // this credential: the notification loop whose first request is often the one adopting it.
  if (!previous) return
  stopStreams()
  readers.clear()
  emit("reset", {})
  if (previous.owner !== known.owner) throw accountChanged()
}

function accountChanged() {
  return new JolliApiError({
    path: "group-chat",
    status: 409,
    code: "account_changed",
    message: "The active Jolli account changed",
  })
}

/**
 * One request as whoever is signed in, and after a 401 one retry with the token that replaced the refused one.
 *
 * ⚠ NEVER UNDER ANOTHER IDENTITY. A retry, or a request that belongs with an earlier one (`identity`: a send
 * after the read that keyed it, a stream's side calls), goes out only for the credential the first one used;
 * otherwise it answers `account_changed`. After a 401 the store may hold somebody who has just signed in, and
 * replaying a send or a read as them would put one person's words or chats under the other's name.
 */
export async function withGroupChatAuth<A>(run: (request: GatewayRequest) => Promise<A>, identity?: string) {
  const request = await currentGroupChatRequest()
  if (identity !== undefined && request.identity !== identity) throw accountChanged()
  ensureNotifications()
  return run(request).catch(async (error: unknown) => {
    if (!(error instanceof JolliApiError) || error.status !== 401 || !session) throw error
    await Effect.runPromise(session.refused(request.token))
    return run(await groupChatRequestAs(request.identity))
  })
}

/** The request for the credential `identity` names, or `account_changed` once another one is active. */
export async function groupChatRequestAs(identity: string) {
  const request = await currentGroupChatRequest()
  if (request.identity !== identity) throw accountChanged()
  return request
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
/**
 * Ask the renderer to read the chat again, shortly, so a burst of events costs one read. The end of a
 * turn (`turn`) waits while an ask of ours is out: the ask ends with one refresh of its own, and the
 * subscription only repeats the frames its response stream relays. Anything else, a classmate's
 * message or a membership change, is read at once even then.
 */
function changed(watch: Watch, turn = false) {
  if (turn && watch.sending) return
  clearTimeout(watch.timer)
  watch.timer = setTimeout(() => relay(watch.identity, "changed", { chatID: watch.id }), 150)
}
async function revoked(watch: Watch) {
  if (watch.revoked) return
  watch.revoked = true
  dispose(watch)
  // The offline copy goes before anyone hears of the revocation, so nothing reads it afterwards.
  await cache
    ?.remove(watch.identity, watch.id)
    .catch((error: unknown) => warn("Group chat: could not purge a revoked chat's offline copy", error))
  relay(watch.identity, "revoked", { chatID: watch.id })
}
/** Access may have changed: the offline copy waits for a read to confirm it, and the renderer reads. */
function accessUnsettled(watch: Watch) {
  void (cache?.unconfirm(watch.identity, watch.id) ?? Promise.resolve())
    .catch((error: unknown) => warn("Group chat: could not mark an offline copy unconfirmed", error))
    .then(() => changed(watch))
}
/**
 * A refusal on the way to a live stream that `accessRevoked` (core) does not count as lost access: jolliedu
 * also answers 403 and 404 for a request it could not place (no tenant context, a topic prefix it does not
 * recognise, a service it lacks). The offline copy stops being served at once, and the renderer's read of
 * the chat decides by the same rule. A 403 asking for SSO sign-in is neither.
 */
function accessInDoubt(error: unknown) {
  return (
    error instanceof JolliApiError &&
    !accessRevoked(error) &&
    error.code !== "sso_required" &&
    (error.status === 403 || error.status === 404)
  )
}

const terminal = new Set(["processing_complete", "message_complete", "cancelled", "error", "agent_turn_orphaned"])
const turnStarts = new Set(["message_received", "typing", "turn_start"])
/** Relay answer text; a frame that starts a turn, or a catch-up (`truncated` given), clears the bubble first. */
function forward(watch: Watch, frame: Frame, truncated?: boolean) {
  if (readers.has(watch.id)) return
  const reset = truncated !== undefined || turnStarts.has(frame.type)
  if (!reset && frame.type !== "content_chunk") return
  relay(watch.identity, "answer", {
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
    releaseLeases(clientID, [key])
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
  }, watch.identity).catch((error: unknown) => {
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
    if (signal.aborted) return
    if (outcome === "stop") {
      // Nothing to retry under this credential, which is no verdict on the chat: the next watch subscribes again.
      relay.abort()
      return
    }
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
    if (terminal.has(frame.type)) changed(watch, true)
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
  // One catch for every step of opening and following the stream, each of which can fail the same few
  // ways; the finally releases the attempt's timer, listener and re-join hook however it ends.
  try {
    const request = await currentGroupChatRequest()
    if (request.identity !== watch.identity) return "stop"
    token = request.token
    const target = chatRequest(request, watch.id)
    const publicId = parseGroupChatID(watch.id).publicId
    const hub = await openHub(target.request, { type: "convo", id: publicId }, attempt.signal)
    if (hub && hub.token.topics.length !== 1) throw new Error("A conversation subscription must have one topic")
    const response =
      hub?.response ??
      (await fetchGroupResource(target.request, `${target.path}/stream`, "GET", undefined, attempt.signal))
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
        accessUnsettled(watch)
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
        void withGroupChatAuth(
          async (fresh) =>
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
          watch.identity,
        )
          .then((result) => {
            if (!result.current) reconnect()
          })
          .catch((error: unknown) => {
            if (attempt.signal.aborted) return
            if (accessRevoked(error)) return void revoked(watch)
            if (accessInDoubt(error)) return void accessUnsettled(watch)
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
    if (accessRevoked(error)) {
      await revoked(watch)
      return "stop"
    }
    // Retried with backoff like any failure, after the renderer has been told to read the chat.
    if (accessInDoubt(error)) accessUnsettled(watch)
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
    }, request.identity)
    const watch = watches.get(key)
    if (watch) return changed(watch)
    return emit("changed", { chatID: id })
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
      const response = await withGroupChatAuth(
        (fresh) => postMessage(fresh, id, body, AbortSignal.any([watch.abort.signal, admission.signal])),
        request.identity,
      )
      if (!response.headers.get("content-type")?.includes("text/event-stream")) {
        await response.body?.cancel()
        accepted = true
        resolve()
        return
      }
      // No `conversation_frames` to unpack here: the server batches frames only when it publishes to
      // Mercure, and writes this response one frame at a time. The subscription unpacks the batches.
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
    })()
      // Once admitted, a failure only ends the relay: the send itself has already been answered.
      .catch((error: unknown) => {
        if (!accepted) reject(error)
      })
      .then(async () => {
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
        if (!watch.revoked) relay(watch.identity, "changed", { chatID: id })
        if (!watch.clients.size) dispose(watch)
      })
  })
}
