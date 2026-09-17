/**
 * EVERY SESSION'S COURSE BINDING, IN ONE PLACE THAT ANY SCREEN CAN READ.
 *
 * ⚠ A MODULE STORE RATHER THAN A CONTEXT, FOR A REASON THE ROUTE TREE FORCES. The Home page renders
 * outside `DirectoryLayout`, so it is outside `CourseSessionProvider` and cannot call
 * `useCourseSession()` at all — and Home is exactly where sessions have to be grouped by course.
 * A context would have to be hoisted above the router to serve both, which is a larger change to
 * upstream's shell than a fork should be making.
 *
 * ⚠ AND GLOBAL RATHER THAN SCOPED PER DIRECTORY, WHICH IS ALSO THE HONEST MODEL. `local.tsx` scopes
 * model selection per workspace because a model preference really is about a working directory. A
 * COURSE is not: one course spans several repositories, and the Home list crosses all of them. Its
 * natural key is the session id, which is already unique.
 *
 * ⚠ WRITTEN THROUGH `localStorage` BY HAND rather than through `utils/persist`, because that helper
 * is built to be called inside a reactive owner and this store has none. The trade is deliberate and
 * small: no migration machinery, no cross-tab sync. In the real product none of this is client state
 * at all — the server owns a session's course (see `session-binding.tsx`).
 */

import { createStore } from "solid-js/store"
import type { SessionSharing } from "./types"

export type CourseBinding = {
  courseId: string
  assistantId: string
  /**
   * ⚠ THE SESSION.S OWN READERS, NOT THE COURSE.S POLICY. Seeded from the policy when the session
   * starts and never re-read from it. A professor who switches a course to private in week six has
   * changed what a NEW session starts as; she has not retracted the ten she has already read, and a
   * store that recomputed this would silently claim she had.
   */
  sharing: SessionSharing
}

// ⚠ v2: `sharing` went from one policy value to two switches (staff, classmates). A v1 entry cannot
// be read as a v2 one, and this is a mock with nothing worth migrating — the old key is abandoned.
const KEY = "jolli-course.v2"

function load(): Record<string, CourseBinding> {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return {}
    return parsed as Record<string, CourseBinding>
  } catch {
    // A private window, cleared site data, or a shape we no longer understand. An empty store is a
    // working product with nothing bound yet, so there is nothing to report and nothing to repair.
    return {}
  }
}

const [sessions, setSessions] = createStore<Record<string, CourseBinding>>(load())

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(sessions))
  } catch {
    // Storage refused (quota, or a context that denies it). The binding still holds for this run,
    // which is what the current screen needs; losing it on reload is the acceptable half of this.
  }
}

export const SessionCourses = {
  /** Reactive: reading this inside a memo re-runs when any binding changes. */
  get all() {
    return sessions
  },
  get(sessionID: string | undefined): CourseBinding | undefined {
    if (!sessionID) return undefined
    return sessions[sessionID]
  },
  set(sessionID: string, binding: CourseBinding) {
    setSessions(sessionID, { ...binding })
    save()
  },
}
