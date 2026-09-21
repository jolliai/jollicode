/**
 * THE COURSES AND ASSISTANTS THIS STUDENT HAS, AS THE SERVER REPORTS THEM.
 *
 * ⚠ IT REPLACED A FILE OF FIXTURES AND KEPT THAT FILE'S SHAPE, DELIBERATELY. Six synchronous
 * functions are called from render bodies and memos all over this package; making them async would
 * have rippled into every one of those call sites. So the data lands in a store and the functions
 * read it, which means "not loaded yet" and "you have no courses" are the same answer here — see
 * {@link ready} for the one caller that must tell them apart.
 *
 * ⚠ THE SERVER DOES THE DECIDING, NOT THIS FILE. Which courses are the student's, which are
 * coding courses, whether one can be started, what a grant means in opencode's model ids — all of
 * that is settled before `/jolli/course` answers. What is left here is lookup and ordering.
 */

import { createSignal } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { Lookup } from "@opencode-ai/core/jolli/lookup"
import { ModelTiers } from "./model-tier"
import type { Assistant, Catalog, Course } from "./types"

const [store, setStore] = createStore<{ courses: readonly Course[]; assistants: readonly Assistant[] }>({
  courses: [],
  assistants: [],
})
const [loaded, setLoaded] = createSignal(false)
/**
 * ⚠ A COUNTER RATHER THAN A FLAG, BECAUSE SOMETHING HAS TO RE-TRIGGER THE FETCH. Clearing the store
 * is not enough on its own: the only caller is an effect tracking the server, and signing in
 * restarts the sidecar on the same host and port, so that effect never re-runs. Reading this in the
 * effect gives the reset something to push against.
 */
const [generation, setGeneration] = createSignal(0)

/** Bumped by {@link resetCatalog}; read by whoever owns the fetch so a reset actually re-asks. */
export const catalogGeneration = generation

/**
 * WHETHER THE ANSWER HAS ARRIVED, WHICH IS NOT THE SAME QUESTION AS WHETHER IT WAS EMPTY.
 *
 * ⚠ ONE CALLER GENUINELY NEEDS THIS AND THE REST MUST NOT. Auto-selecting a student's only course
 * has to wait for the list, because "exactly one" and "none yet" are indistinguishable while it is
 * still in flight. Everything else renders an empty list as an empty list and corrects itself when
 * the data lands, which is what a store is for.
 */
export const ready = loaded

/** Called once the server has answered. */
export function setCatalog(catalog: Catalog) {
  setStore(
    produce((draft) => {
      draft.courses = catalog.courses
      draft.assistants = catalog.assistants
    }),
  )
  ModelTiers.set(catalog.modelTiers)
  setLoaded(true)
}

export function courseById(id: string | undefined): Course | undefined {
  return Lookup.courseById(store, id)
}

export function assistantById(id: string | undefined): Assistant | undefined {
  return Lookup.assistantById(store, id)
}

/**
 * ⚠ THE `kind === "code"` FILTER THE FIXTURES HAD IS GONE. It separated an editor assistant from a
 * help-desk one, a distinction the gateway does not make — being a coding course is a property of
 * the COURSE (`requiresCoding`), and a non-coding course never reaches this client at all.
 */
export function assistantsForCourse(courseId: string | undefined): Assistant[] {
  return Lookup.assistantsForCourse(store, courseId)
}

/** The assistant a student gets when they pick nobody: the professor's default, which sorts first. */
export function defaultAssistantFor(courseId: string | undefined): Assistant | undefined {
  return Lookup.defaultAssistantFor(store, courseId)
}

/**
 * EVERY COURSE THIS STUDENT HAS IN JOLLI CODE — INCLUDING THE ONES THEY CANNOT OPEN YET.
 *
 * ⚠ IT NO LONGER HIDES DRAFTS, AND THAT IS A REVERSAL WORTH READING. The fixtures listed only
 * published courses, on the reasoning that a course a professor is still writing should not be
 * visible. But a student whose only course is unpublished then meets an empty list that cannot say
 * why — while a greyed row reading "your instructor hasn't published this yet" can. Whether a
 * course can be STARTED is {@link canStartSession}, and the picker renders the difference.
 */
export function enrolledCourses(): Course[] {
  return [...store.courses]
}

export function canStartSession(courseId: string | undefined): boolean {
  return Lookup.canStartSession(store, courseId)
}

/** What is in the way of starting this course, as the code the picker puts into words. */
export function blockedReason(course: Course) {
  return Lookup.blockedReason(store, course)
}

/** ⚠ An empty grant means UNRESTRICTED. Kept for the callers that named it. */
export const UNRESTRICTED: string[] = []

/**
 * LOAD THE CATALOGUE ONCE PER SERVER, HOWEVER MANY SCREENS ASK FOR IT.
 *
 * ⚠ `CourseSessionProvider` MOUNTS TWICE — once on the new-session route and once inside the
 * directory layout — so a fetch in its `init` would run twice on every launch. Keyed on the server
 * so switching servers does re-ask, and an in-flight promise is shared rather than raced.
 *
 * ⚠ A FAILURE IS NOT CACHED. The catalogue is what the course picker is made of; if the first
 * attempt lost a race with the sidecar coming up, the next screen to ask should get a real attempt
 * rather than a remembered empty list.
 *
 * ⚠ THE SERVER URL IS NOT A SUFFICIENT KEY ON ITS OWN, AND SIGNING IN IS WHY. The app mounts before
 * the student has signed in — `AppInterface` renders its children without waiting on the onboarding
 * promise — so the first ask happens with no credential and is answered with an empty catalogue.
 * Signing in then restarts the sidecar on THE SAME host and port, so nothing here would look
 * different and the empty answer would stand until the app was restarted. The desktop calls
 * {@link resetCatalog} when sign-in completes; anything else that changes who the server is
 * authenticated as must do the same.
 */
let inFlight: { key: string; promise: Promise<void> } | undefined

export function ensureCatalog(key: string, load: () => Promise<Catalog>): Promise<void> {
  if (inFlight?.key === key) return inFlight.promise
  const promise = load()
    .then((catalog) => {
      /**
       * ⚠ A LATE ANSWER TO A SUPERSEDED QUESTION IS DROPPED, AND SIGNING IN IS WHY IT MATTERS.
       * Nothing cancels a request already in flight, so the empty catalogue the pre-sign-in ask is
       * answered with can still land AFTER the real one — and `inFlight` would by then hold the new
       * key, so no screen would ever ask again. The key carries the generation; comparing it here is
       * what makes that counter protect the write as well as the fetch.
       */
      if (inFlight?.key !== key) return
      setCatalog(catalog)
    })
    .catch(() => {
      if (inFlight?.key === key) inFlight = undefined
    })
  inFlight = { key, promise }
  return promise
}

/**
 * Drop what is loaded and make the owner of the fetch ask again. For sign-in and server changes.
 *
 * ⚠ IT ALSO CLEARS THE TIER MAP, which belongs to the same answer. Leaving the previous account's
 * tiers behind would have the coaching nudge reasoning about models this student cannot run.
 */
export function resetCatalog() {
  inFlight = undefined
  setLoaded(false)
  setStore(
    produce((draft) => {
      draft.courses = []
      draft.assistants = []
    }),
  )
  ModelTiers.set({})
  setGeneration((value) => value + 1)
}
