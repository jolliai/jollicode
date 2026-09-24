/**
 * ONE SESSION'S JOLLI READERS, READ ONCE AND SHARED BY EVERY SURFACE THAT SHOWS THEM.
 *
 * Two places ask who can read a session: the share panel and the coaching gate. They read one
 * cache entry under one key, so a grant written in the panel reaches the gate at once, and neither
 * can hold a different answer from the other.
 *
 * ⚠ THE READ IS NOT FREE. The sidecar's `/jolli/session/:sessionID/share` pulls the conversation
 * detail and the course roster from the gateway, so nothing asks for it just because a session is
 * on screen: the panel asks each time it opens, and the coaching gate only when a writer would
 * otherwise see the exchange and the cached answer is stale (`useStaffCanRead`).
 */
import type { Jolli } from "@opencode-ai/schema/jolli"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { courseById } from "./catalog"
import { staffCanRead } from "./session-share"

/**
 * HOW OLD AN ANSWER THE COACHING GATE WILL TRUST. A grant withdrawn anywhere stops reaching a model
 * within this long, and a burst of notes on one turn shares one read.
 */
const GATE_FRESH_MS = 30_000

/** Every share query for a session starts with this, so a write can update them all by prefix. */
export function shareQueryKey(serverURL: string, sessionID: string) {
  return ["jolli", "share", serverURL, sessionID] as const
}

export function useSessionShare(sessionID: () => string | undefined, options?: { fresh?: boolean }) {
  const serverSDK = useServerSDK()
  return useQuery(() => {
    const id = sessionID()
    return {
      queryKey: shareQueryKey(serverSDK().url, id ?? ""),
      queryFn: () => readShare(serverSDK(), id!),
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
      .fetchQuery({
        queryKey: shareQueryKey(serverSDK().url, id),
        queryFn: () => readShare(serverSDK(), id),
        staleTime: GATE_FRESH_MS,
      })
      .then(staffCanRead, () => false)
  }
}

function readShare(serverSDK: ReturnType<ReturnType<typeof useServerSDK>>, id: string) {
  return serverSDK.client.jolli
    .share({ sessionID: id }, { throwOnError: true })
    .then((response) => response.data as Jolli.SessionShare)
}

/**
 * WHAT TO CALL THE SESSION'S COURSE IN A SENTENCE.
 *
 * ⚠ THE GATEWAY'S CODE FIRST, THEN THIS STUDENT'S CATALOGUE. jolliedu reads `courseCode` off a course
 * profile that not every course has, and answers null without one — while the catalogue this app
 * already holds names the same course by its code or, failing that, its title. "This course" is the
 * last resort, not the first.
 */
export function courseLabel(language: ReturnType<typeof useLanguage>, share: Jolli.SessionShare) {
  if (share.courseCode) return share.courseCode
  const course = share.courseId === null ? undefined : courseById(String(share.courseId))
  return course?.code || course?.title || language.t("session.share.thisCourse")
}
