/**
 * WHICH COURSE AND ASSISTANT A SESSION IS BOUND TO — READ OFF THE SESSION ITSELF.
 *
 * ⚠ THIS USED TO BE A `localStorage` MAP AND IT IS NOW A PROJECTION. Its own header said so: "in
 * the real product none of this is client state at all — the server owns a session's course." The
 * binding is written into the session's `metadata` as it is created and comes back with every read
 * of that session, so there is nothing left to store, migrate, or keep in step across tabs.
 *
 * ⚠ IT MOVED INTO CORE WHEN THE TUI LEARNED ABOUT COURSES. Both renderers read a binding back off
 * a session they did not create — the desktop app on every session route, the TUI to show which
 * course a transcript belongs to — and "what counts as bound" is exactly the kind of question that
 * must not have two answers. The write side is each renderer's own; this, the read, is shared.
 *
 * ⚠ THE FUNCTIONS TAKE A SESSION RATHER THAN AN ID, WHICH IS THE WHOLE SIMPLIFICATION. A store
 * keyed by id needed a reactive owner to stay fresh, and Home renders outside every provider —
 * that constraint is what made the old module a module. A caller that has the session in hand has
 * the binding in hand.
 *
 * ⚠ AND NOTHING VALIDATES DEEPLY. `metadata` is an untyped bag shared with other features, so this
 * checks the two fields it reads and ignores the rest: a session bound by an older build, or by
 * something that wrote nonsense, reads as unbound rather than throwing inside a render.
 */

/**
 * ⚠ NO READERS HERE. Who can read a session is Jolli Edu's per-session grants, read through the
 * sidecar's `/jolli/session/:sessionID/share`; an older build also wrote a `sharing` field into this
 * bag, which is now ignored on read and no longer written.
 */
export type CourseBinding = {
  courseId: string
  assistantId: string
}

/** Anything with the metadata bag a session carries. */
export type SessionLike = { metadata?: Record<string, unknown> | undefined }

export function courseBindingOf(session: SessionLike | undefined): CourseBinding | undefined {
  const raw = session?.metadata?.["jolli"]
  if (!raw || typeof raw !== "object") return undefined
  const value = raw as Partial<CourseBinding>
  if (typeof value.courseId !== "string" || typeof value.assistantId !== "string") return undefined
  return { courseId: value.courseId, assistantId: value.assistantId }
}
