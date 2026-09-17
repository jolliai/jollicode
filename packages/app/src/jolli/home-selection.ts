/**
 * WHICH COURSE THE HOME SCREEN IS FILTERED TO, IF ANY.
 *
 * ⚠ COURSE AND PROJECT ARE TWO WAYS OF SLICING ONE LIST, NOT TWO FILTERS THAT COMBINE. Selecting a
 * course clears the project selection and the reverse, because "sessions in CS 310 that are also in
 * ~/repo" is a question a student does not have; what they have is "my CS 310 work" or "this
 * repository's work". Holding both would also make the session row's secondary label ambiguous —
 * it exists to show the axis you are NOT filtering by.
 *
 * ⚠ NOT PERSISTED, DELIBERATELY. This is where you are looking right now, in the same category as
 * an open dropdown. Upstream persists the project selection because a project is a thing you keep
 * open; a filter is not.
 */

import { createSignal } from "solid-js"

const [courseId, setCourseId] = createSignal<string | undefined>(undefined)

export const HomeCourseSelection = {
  courseId,
  select(id: string | undefined) {
    setCourseId(id)
  },
  clear() {
    setCourseId(undefined)
  },
}
