import type { Event, Session, SessionV2Info, V2SessionListResponse } from "@opencode-ai/sdk/v2/client"
import type { QueryClient } from "@tanstack/solid-query"
import { trimSessions } from "./session-trim"
import { pathKey } from "@/utils/path-key"

export const HOME_V2_SESSION_PAGE_LIMIT = 5_000

export type HomeSessionEvent = {
  type: "session.created" | "session.updated" | "session.deleted"
  properties: { sessionID: string; info: Session }
}
export type HomeSessionEvents = {
  sequence: number
  entries: Array<{ sequence: number; event: HomeSessionEvent }>
}
export type HomeSessionIndex = {
  sessions: Session[]
  eventSequence: number
}

export const homeSessionIndexKey = (server: string) => ["home", "session-index", server] as const
export const homeSessionEventsKey = (server: string) => ["home", "session-events", server] as const

type HomeSessionPage = { data?: V2SessionListResponse }

export async function loadHomeSessionIndex(
  list: (
    input: { limit: number; order: "desc"; cursor?: string },
    options: { signal?: AbortSignal },
  ) => Promise<HomeSessionPage>,
  eventSequence = 0,
  signal?: AbortSignal,
) {
  const data: SessionV2InfoWithMetadata[] = []
  let cursor: string | undefined

  for (;;) {
    const response = await list(
      {
        limit: HOME_V2_SESSION_PAGE_LIMIT,
        order: "desc",
        ...(cursor ? { cursor } : {}),
      },
      { signal },
    )
    const page = response.data!
    data.push(...page.data)
    if (page.data.length < HOME_V2_SESSION_PAGE_LIMIT || !page.cursor.next)
      return { sessions: parseHomeSessionIndex(data), eventSequence }
    cursor = page.cursor.next
  }
}

export function appendHomeSessionEvent(current: HomeSessionEvents | undefined, event: HomeSessionEvent) {
  const sequence = (current?.sequence ?? 0) + 1
  return {
    sequence,
    entries: [...(current?.entries ?? []), { sequence, event }],
  }
}

export function trimHomeSessionEvents(current: HomeSessionEvents | undefined, sequence: number): HomeSessionEvents {
  return {
    sequence: current?.sequence ?? sequence,
    entries: (current?.entries ?? []).filter((entry) => entry.sequence > sequence),
  }
}

export function homeSessionIndexSessions(index: HomeSessionIndex | undefined, events: HomeSessionEvents | undefined) {
  if (!index) return []
  return (events?.entries ?? [])
    .filter((entry) => entry.sequence > index.eventSequence)
    .reduce((sessions, entry) => applyHomeSessionEvent(sessions, entry.event), index.sessions)
}

export function homeSessionIndexRefresh(event: Event["type"], connected: boolean) {
  if (event === "server.connected") return { connected: true, refetch: connected }
  return {
    connected,
    refetch: event === "global.disposed" || event === "session.next.moved",
  }
}

export function createHomeSessionIndexCache(queryClient: QueryClient, server: string) {
  const indexKey = homeSessionIndexKey(server)
  const eventsKey = homeSessionEventsKey(server)
  let connected = false
  const removed = new Set<string>()

  return {
    indexKey,
    eventsKey,
    eventSequence() {
      return queryClient.getQueryData<HomeSessionEvents>(eventsKey)?.sequence ?? 0
    },
    complete(sequence: number) {
      // Keep events received after the fetch began so its response cannot overwrite them.
      queryClient.setQueryData<HomeSessionEvents>(eventsKey, (current) => trimHomeSessionEvents(current, sequence))
    },
    sessions(index: HomeSessionIndex | undefined, events: HomeSessionEvents | undefined) {
      const sessions = homeSessionIndexSessions(index, events)
      return removed.size === 0 ? sessions : sessions.filter((session) => !removed.has(session.id))
    },
    apply(event: HomeSessionEvent) {
      if (!queryClient.getQueryState(indexKey)) return
      const next = appendHomeSessionEvent(queryClient.getQueryData<HomeSessionEvents>(eventsKey), event)
      if (queryClient.isFetching({ queryKey: indexKey, exact: true }) > 0) {
        queryClient.setQueryData(eventsKey, next)
        return
      }

      const index = queryClient.getQueryData<HomeSessionIndex>(indexKey)
      if (index) {
        queryClient.setQueryData<HomeSessionIndex>(indexKey, {
          sessions: homeSessionIndexSessions(index, next),
          eventSequence: next.sequence,
        })
      }
      queryClient.setQueryData<HomeSessionEvents>(eventsKey, { sequence: next.sequence, entries: [] })
    },
    /**
     * PUT A SESSION INTO THE INDEX AS SOON AS THE CLIENT CREATES IT, RATHER THAN WHEN THE SERVER
     * SAYS SO.
     *
     * ⚠ THIS IS THE COUNTERPART OF `remove`, AND IT EXISTS FOR THE SAME REASON: the sidebar's list
     * and its search read this index and nothing else, so a session that has only been written to
     * the per-directory store — which is all `submit.ts`'s `seed` used to do — exists on the session
     * route and nowhere a reader can find it. Waiting for `session.created` to come back over the
     * event stream is not good enough for a list the reader is looking at while they create one.
     *
     * ⚠ IT HOLDS THE INDEX'S INVARIANT: roots that are not archived, the same set
     * `parseHomeSessionIndex` and `applyHomeSessionEvent` keep. A child session belongs to its
     * parent's transcript, and an archived one has already been taken out of this list on purpose.
     *
     * ⚠ AND IT CLEARS THE `removed` TOMBSTONE, because ids are not reused but a session CAN be
     * re-added by a later event after a failed delete — leaving the tombstone would filter the row
     * out of the list for the rest of the session.
     */
    add(session: Session) {
      if (session.parentID || typeof session.time.archived === "number") return
      removed.delete(session.id)
      if (!queryClient.getQueryState(indexKey)) return
      queryClient.setQueryData<HomeSessionIndex>(indexKey, (index) => {
        if (!index) return index
        const at = index.sessions.findIndex((item) => item.id === session.id)
        if (at === -1) return { ...index, sessions: [...index.sessions, session] }
        return { ...index, sessions: index.sessions.with(at, session) }
      })
    },
    remove(sessionID: string) {
      removed.add(sessionID)
      if (!queryClient.getQueryState(indexKey)) return
      queryClient.setQueryData<HomeSessionIndex>(indexKey, (index) => {
        if (!index) return index
        const at = index.sessions.findIndex((session) => session.id === sessionID)
        if (at === -1) return index
        return { ...index, sessions: index.sessions.toSpliced(at, 1) }
      })
    },
    refresh(event: Event["type"]) {
      const result = homeSessionIndexRefresh(event, connected)
      connected = result.connected
      if (!result.refetch) return
      void queryClient.refetchQueries({ queryKey: indexKey, exact: true, type: "active" })
    },
  }
}

// TODO(v2): This deliberately dumb full-table scan is necessary because the
// current V2 API orders by creation time and cannot filter roots, archives, or
// multiple directories. A bounded page could omit an old session updated today.
// Once released, use client.v2.project.list() and client.v2.session.list({
// parentID: null, order: "desc" }), then remove this adapter and its V1 fields.
export function parseHomeSessionIndex(sessions: SessionV2InfoWithMetadata[]): Session[] {
  return sessions.flatMap((item) => {
    if (item.parentID || typeof item.time.archived === "number") return []
    return [toLegacySummary(item)]
  })
}

export function retainHomeSessions(sessions: Session[], limit: number, now: number) {
  const grouped = Map.groupBy(sessions, (session) => pathKey(session.directory))
  return [...grouped.values()].flatMap((items) => trimSessions(items, { limit, permission: {}, now }))
}

export function applyHomeSessionEvent(sessions: Session[], event: HomeSessionEvent) {
  const info = event.properties.info
  const index = sessions.findIndex((session) => session.id === info.id)
  if (event.type === "session.deleted" || info.parentID || typeof info.time.archived === "number") {
    if (index === -1) return sessions
    return sessions.toSpliced(index, 1)
  }
  if (event.type !== "session.created" && event.type !== "session.updated") return sessions
  if (index === -1) return [...sessions, info]
  return sessions.with(index, info)
}

/**
 * ⚠ `metadata` IS DECLARED BY HAND BECAUSE THE GENERATED `SessionV2Info` PREDATES IT — the same
 * stale-codegen workaround `normalizeSessionInfo` documents in `utils/session.ts`. The field is on
 * the wire: `SessionV2.Info` lists it (`schema/src/session.ts`) and `fromRow` fills it from the
 * session table (`core/src/session/info.ts`).
 */
type SessionV2InfoWithMetadata = SessionV2Info & { metadata?: Record<string, unknown> }

/**
 * ⚠ THIS REBUILDS THE OBJECT FIELD BY FIELD, SO A FIELD LEFT OUT IS DELETED RATHER THAN IGNORED —
 * the trap `normalizeSessionInfo` was fixed for, in the one projection that did not go through it.
 * The sidebar reads its whole list out of this index, so dropping `metadata` dropped Jolli's course
 * binding (`core/jolli/binding.ts`) off every row: `buildHomeSessionRecords` resolved `course` to
 * undefined for all of them, and selecting a course in the sidebar then filtered the list to
 * nothing, because no record could ever match the selected id.
 */
function toLegacySummary(session: SessionV2InfoWithMetadata): Session {
  return {
    metadata: session.metadata,
    id: session.id,
    slug: session.id,
    projectID: session.projectID,
    workspaceID: session.location.workspaceID,
    directory: session.location.directory,
    path: session.subpath,
    parentID: session.parentID,
    cost: session.cost,
    tokens: session.tokens,
    title: session.title,
    agent: session.agent,
    model: session.model,
    version: "",
    time: session.time,
  }
}
