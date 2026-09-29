/**
 * ONE SESSION'S JOLLI READERS, READ ONCE AND SHARED BY EVERY SURFACE THAT SHOWS THEM.
 *
 * Two places ask who can read a session in full: the share panel and the coaching gate. They read
 * one cache entry under one key, so a grant written in the panel reaches the gate at once, and
 * neither can hold a different answer from the other.
 *
 * ⚠ THE FULL READ IS NOT FREE. The sidecar's `/jolli/session/:sessionID/share` pulls the
 * conversation detail — its whole timeline — and the course roster from the gateway, so nothing asks
 * for it just because a session is on screen: the panel asks each time it opens, and the coaching
 * gate only when a writer would otherwise see the exchange and the cached answer is stale
 * (`useStaffCanRead`). The header's share button, which is on screen, asks the cheap readers-only
 * read instead (`useSessionReaders`).
 */
import type { Jolli } from "@opencode-ai/schema/jolli"
import { matchQuery, type QueryClient, useQuery, useQueryClient } from "@tanstack/solid-query"
import { createEffect, onCleanup } from "solid-js"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { courseById } from "./catalog"
import { applyWrite, staffCanRead } from "./session-share"

/**
 * HOW OLD AN ANSWER THE COACHING GATE WILL TRUST. A grant withdrawn anywhere stops reaching a model
 * within this long, and a burst of notes on one turn shares one read.
 */
const GATE_FRESH_MS = 30_000

/**
 * HOW OLD THE HEADER BUTTON'S ANSWER MAY GET BEFORE A REMOUNT OR A RETURN TO THE WINDOW ASKS AGAIN.
 * Short, because the read is cheap and a grant withdrawn on the web should not go on saying `Sharing`.
 */
const READERS_FRESH_MS = 30_000

export function useSessionShare(sessionID: () => string | undefined, options?: { fresh?: boolean }) {
  const serverSDK = useServerSDK()
  return useQuery(() => {
    const id = sessionID()
    return {
      ...shareQuery(serverSDK(), id ?? ""),
      enabled: !!id,
      /**
       * ⚠ `fresh` IS THE PANEL'S: it shows the last answer at once and then asks again, against the
       * app's `refetchOnMount: false` default — a grant withdrawn from another device must not linger
       * where the student is about to act on it.
       */
      ...(options?.fresh ? { staleTime: 0, refetchOnMount: "always" as const } : {}),
    }
  })
}

/**
 * THE ANSWER, OR NOTHING WHILE THE FIRST ONE IS IN FLIGHT — how every surface reads the share.
 *
 * ⚠ NEVER `query.data` DIRECTLY. solid-query's `data` is a resource read, and with nothing cached it
 * suspends the NEAREST boundary — the session route's `<Suspense>`, not the surface asking. That
 * takes the session off screen and defers every effect under it, the share popover's positioning
 * among them, so the first open after launch drew the panel at the window's top-left until the
 * gateway answered. `isPending` is plain state and never suspends.
 */
export function shareAnswer(query: ReturnType<typeof useSessionShare>) {
  return query.isPending ? undefined : query.data
}

/**
 * WHO CAN READ THE SESSION, FOR THE HEADER'S SHARE BUTTON — asked for every session it shows.
 *
 * ⚠ ONE ENTRY, FED FROM THREE PLACES: its own readers-only read (`readersQuery`), every write that
 * lands (`applyShareWrite`), and every full read the panel or the coaching gate makes
 * (`followFullReads`). So what the panel learns reaches the button at once, and the button never
 * holds the roster that came with it.
 */
export function useSessionReaders(sessionID: () => string | undefined) {
  const serverSDK = useServerSDK()
  const queryClient = useQueryClient()
  createEffect(() => {
    const id = sessionID()
    if (id) onCleanup(followFullReads(queryClient, serverSDK().url, id))
  })
  const query = useQuery(() => {
    const id = sessionID()
    return { ...readersQuery(serverSDK(), id ?? ""), enabled: !!id }
  })
  return () => shareAnswer(query)
}

export function useApplyShareWrite(sessionID: () => string) {
  const serverSDK = useServerSDK()
  const queryClient = useQueryClient()
  return (write: Jolli.SessionShare) => applyShareWrite(queryClient, serverSDK().url, sessionID(), write)
}

/**
 * WHETHER COURSE STAFF CAN READ THE SESSION, ASKED FRESH — the coaching gate's read.
 *
 * ⚠ NOT WHATEVER THE PANEL LAST READ. Nothing refetches the cache while a session stays open (the
 * app-wide defaults), so a grant withdrawn on the web would go on handing the exchange to a model.
 * This goes through the same cache entry, trusts it only while it is under {@link GATE_FRESH_MS}
 * old, and reads anything that goes wrong as "cannot" — the safe direction.
 */
export function useStaffCanRead(sessionID: () => string | undefined) {
  const serverSDK = useServerSDK()
  const queryClient = useQueryClient()
  return () => {
    const id = sessionID()
    if (!id) return Promise.resolve(false)
    return queryClient
      .fetchQuery({ ...shareQuery(serverSDK(), id), staleTime: GATE_FRESH_MS })
      .then(staffCanRead, () => false)
  }
}

/**
 * THE FULL READ'S KEY AND FETCH, FOR EVERY OBSERVER OF IT — the panel and the gate. One definition,
 * so neither can come to name a different entry from the other.
 */
export function shareQuery(server: Server, id: string) {
  return {
    queryKey: shareQueryKey(server.url, id),
    queryFn: () =>
      server.client.jolli
        .share({ sessionID: id }, { throwOnError: true })
        .then((response) => response.data as Jolli.SessionShare),
  }
}

/**
 * THE READERS-ONLY READ, UNDER ITS OWN KEY. It carries no roster, so it must never be what the panel
 * or the coaching gate finds under theirs.
 *
 * ⚠ IT FAILS RATHER THAN ANSWERS WITH NOTHING. `unreachable` carries no readers, and a query that
 * resolved with it would replace the last answer that did say something — turning a shared session's
 * button back to `Share` because one request failed. A failed query keeps its data. Not retried:
 * each attempt is a gateway round trip, and the next focus asks again.
 */
export function readersQuery(server: Server, id: string) {
  return {
    queryKey: readersQueryKey(server.url, id),
    queryFn: () =>
      server.client.jolli.shareReaders({ sessionID: id }, { throwOnError: true }).then((response) => {
        const answer = response.data as Jolli.SessionShare
        if (!says(answer)) throw new Error(`Jolli readers read answered ${answer.status}`)
        return answer
      }),
    staleTime: READERS_FRESH_MS,
    retry: false,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
  }
}

/**
 * LANDS A WRITE'S ANSWER IN BOTH OF THE SESSION'S ENTRIES — the full read's, which the panel and the
 * gate hold, and the readers read's, which the header's button holds.
 *
 * ⚠ ONLY A WRITE THAT LANDED. A refusal or a dropped connection changed nothing on Jolli, so it
 * leaves both entries as they were.
 *
 * ⚠ A READ IN FLIGHT WAS SENT BEFORE THE WRITE LANDED, and landing after it would put a withdrawn
 * grant back. The readers read is cancelled before its entry is replaced. The full read is asked
 * again rather than cancelled: a plain cancel reverts, so the coaching gate awaiting it would
 * resolve with the entry from before it asked, while a refetch cancels silently and hands that
 * caller the new read's answer instead.
 */
export async function applyShareWrite(
  queryClient: QueryClient,
  serverURL: string,
  sessionID: string,
  write: Jolli.SessionShare,
) {
  if (!says(write)) return write
  const full = shareQueryKey(serverURL, sessionID)
  const readers = readersQueryKey(serverURL, sessionID)
  await queryClient.cancelQueries({ queryKey: readers })
  queryClient.setQueryData<Jolli.SessionShare>(full, (current) => (current ? applyWrite(current, write) : current))
  // A write answers as the readers read does — the readers, no roster — so it replaces that entry whole.
  queryClient.setQueryData(readers, write)
  // `paused` too: a read held back while offline still goes out, and still carries the old state.
  const inFlight = queryClient.getQueryState(full)?.fetchStatus
  if (inFlight && inFlight !== "idle") void queryClient.refetchQueries({ queryKey: full, exact: true })
  return write
}

/**
 * CARRIES EVERY FULL READ THAT LANDS INTO THE READERS ENTRY, so the button shows what the panel and
 * the gate just learned. Returns the unsubscribe.
 *
 * ⚠ ONLY A FETCH THAT LANDED. Writes fill both entries themselves (`applyShareWrite`), and a read
 * cancelled for being older than a write never dispatches its answer, so it cannot bring back what
 * the write took away.
 *
 * ⚠ AS A READERS ANSWER, THE ROSTER STRIPPED. The header keeps this entry alive for as long as it is
 * on screen; a course's addresses have no business being held there.
 */
export function followFullReads(queryClient: QueryClient, serverURL: string, sessionID: string) {
  const full = { queryKey: shareQueryKey(serverURL, sessionID), exact: true }
  const readers = readersQueryKey(serverURL, sessionID)
  return queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || event.action.type !== "success" || event.action.manual) return
    if (!matchQuery(full, event.query)) return
    const answer = event.query.state.data as Jolli.SessionShare | undefined
    if (!answer || !says(answer)) return
    queryClient.setQueryData<Jolli.SessionShare>(readers, {
      ...answer,
      members: [],
      classSize: 0,
      roster: "unavailable",
    })
  })
}

type Server = ReturnType<ReturnType<typeof useServerSDK>>

/** Whether an answer says who can read the session — the only kind the button's entry may hold. */
function says(answer: Jolli.SessionShare) {
  return answer.status === "ok" || answer.status === "unsynced"
}

function shareQueryKey(serverURL: string, sessionID: string) {
  return ["jolli", "share", serverURL, sessionID] as const
}

/** Its own entry beneath the full read's key: reached by that key's prefix, never found by an exact ask for it. */
function readersQueryKey(serverURL: string, sessionID: string) {
  return [...shareQueryKey(serverURL, sessionID), "readers"] as const
}

/**
 * WHAT TO CALL THE SESSION'S COURSE IN A SENTENCE.
 *
 * ⚠ THE GATEWAY'S CODE FIRST, THEN THIS STUDENT'S CATALOGUE. jolliedu reads `courseCode` off a course
 * profile that not every course has, and answers null without one — while the catalogue this app
 * already holds names the same course by its code or, failing that, its title. "This course" is the
 * last resort, not the first — and the whole answer while the share has not been read yet.
 */
export function courseLabel(language: ReturnType<typeof useLanguage>, share: Jolli.SessionShare | undefined) {
  if (share?.courseCode) return share.courseCode
  const course = share && share.courseId !== null ? courseById(String(share.courseId)) : undefined
  return course?.code || course?.title || language.t("session.share.thisCourse")
}
