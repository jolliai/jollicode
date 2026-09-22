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
import type { Assistant, Catalog, Course, Viewer } from "./types"

const [store, setStore] = createStore<{
  courses: readonly Course[]
  assistants: readonly Assistant[]
  /**
   * ⚠ IT RIDES ALONG WITH THE COURSES RATHER THAN HAVING A STORE OF ITS OWN, because it arrives in
   * the same response from the same token. A second store would be a second thing to reset, a
   * second thing to key by server, and a second opportunity to be describing a different student
   * than the course list is.
   */
  viewer?: Viewer
}>({
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
 * ⚠ TWO CALLERS GENUINELY NEED THIS AND THE REST MUST NOT — an earlier version of this note said
 * one. Auto-selecting a student's only course has to wait for the list, because "exactly one" and
 * "none yet" are indistinguishable while it is still in flight. The sidebar's account row needs it
 * for the same reason in a different shape: "signed out" and "not asked yet" are both an absent
 * viewer, and the row says something different for each. Everything else renders an empty list as an
 * empty list and corrects itself when the data lands, which is what a store is for.
 *
 * ⚠ IT MEANS "THE SERVER REPLIED", NOT "THE GATEWAY DID", AND THE ACCOUNT ROW IS WHY. An
 * `unreachable` answer is still a reply, and it settles the question that row is asking: the viewer
 * is read off the stored token before anything is fetched (`handlers/jolli.ts`), so a reply with no
 * viewer in it means there is no credential. Holding this false until the gateway answers left a
 * signed-out student on a bad network looking at "Account" for the life of the process, waiting on
 * a request that was never going to come back. The COURSES stay unknown in that state, which is why
 * {@link ensureCatalog} writes none of them.
 */
export const ready = loaded

/**
 * WHO THE SERVER SAYS IS SIGNED IN, IF THE TOKEN WOULD SAY.
 *
 * ⚠ ABSENT MEANS "WE CANNOT TELL", NOT "SIGNED OUT" — and not until {@link ready} does it mean
 * anything at all. See `packages/core/src/jolli/identity.ts`: nothing may branch on this beyond
 * which words to draw.
 */
export function viewer(): Viewer | undefined {
  return store.viewer
}

/**
 * Called once the server has answered.
 *
 * ⚠ THE ARGUMENT IS TYPED `Catalog` AND IS NOT ONE — IT IS WHATEVER CAME BACK OVER HTTP. The single
 * caller reaches this through `response.data as Catalog`, an assertion with nothing behind it.
 *
 * ⚠ WHAT IS COERCED BELOW IS WHAT WOULD CRASH IF IT WERE ABSENT, WHICH IS NARROWER THAN VALIDATING
 * THE SHAPE, AND THAT IS THE RULE RATHER THAN AN OVERSIGHT. A field can go missing here for a
 * reason that happens in the field: the app talks to whichever server it is pointed at, and one
 * older than the field simply does not send it. A field cannot arrive with the WRONG TYPE for that
 * reason — a server that has it encodes it through `Jolli.Catalog` — so guarding against that would
 * mean distrusting a server's own published schema, which is a whole-shape decode rather than two
 * `Array.isArray` calls. So `courses` and `assistants` are coerced because they are spread, while
 * `viewer` and `modelTiers` are written through `?.` and `??` instead, where absent is already a
 * no-op.
 *
 * ⚠ AND A MISSING `courses` USED TO TAKE THE WHOLE APPLICATION DOWN, which is what taught us that
 * rule. `enrolledCourses()` spreads this array; assigning `undefined` to it made that
 * `[...undefined]`, a `TypeError` thrown from a render — and since the sidebar reads it at the top
 * of a layout that is mounted on every route, the result was the error screen rather than a missing
 * section. That was survivable while only the home page read courses and only two routes fetched
 * them; both stopped being true when the sidebar became the navigation.
 *
 * ⚠ AN UNPARSEABLE ANSWER IS STILL AN ANSWER, so `loaded` is set either way. It means "the server
 * has replied", and the callers that need it — the account row, the course pre-selection — are
 * asking whether to keep waiting, not whether the reply was any good.
 *
 * ⚠ AND IT IS ONLY EVER REACHED WITH AN `ok` ANSWER — see {@link ensureCatalog}, which takes an
 * `unreachable` one apart rather than passing it here: it keeps the identity that answer carries
 * and drops its empty collections, so nothing overwrites a catalogue with a failure.
 */
export function setCatalog(catalog: Catalog) {
  const payload = catalog as Partial<Catalog> | undefined
  setStore(
    produce((draft) => {
      draft.courses = Array.isArray(payload?.courses) ? payload.courses : []
      draft.assistants = Array.isArray(payload?.assistants) ? payload.assistants : []
      draft.viewer = payload?.viewer
    }),
  )
  ModelTiers.set(payload?.modelTiers ?? {})
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

/**
 * THE COURSES A NAVIGATION LIST SHOWS: the ones that can be opened, or — when none can — all of
 * them, so that an empty column can say why it is empty.
 *
 * ⚠ THIS IS THE MIDDLE OF THE TWO RULES ABOVE IT, AND BOTH EXTREMES HAVE BEEN SHIPPED. Listing
 * published courses only (the fixtures' rule) left a student whose single course was unpublished
 * staring at nothing; listing everything (the rule {@link enrolledCourses} still implements) filled
 * the sidebar with draft, ended and archived courses that cannot be clicked into a session. The
 * only case the explanation is needed for is the one where there is nothing else to show.
 *
 * ⚠ IT IS NOT WHAT THE PICKER USES, DELIBERATELY. `prompt-course-selector` lists every enrolment
 * with its `blockedReason` spelled out, because refusing a course a student went looking for is
 * information; a filter row in a 300px column that they did not ask for is not.
 */
export function listedCourses(): Course[] {
  const all = enrolledCourses()
  const startable = all.filter((course) => canStartSession(course.id))
  return startable.length > 0 ? startable : all
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
 * ⚠ THERE ARE THREE ASKERS AND THEY OVERLAP ON EVERY LAUNCH — `CourseSessionProvider` mounts once
 * on the new-session route and once inside the directory layout, and `ServerScopedProviders` asks
 * from above both so the home route has the answer too (see `catalog-fetch.ts`). Keyed on the
 * server so switching servers does re-ask, and an in-flight promise is shared rather than raced.
 *
 * ⚠ A FAILURE IS NOT CACHED, AND AN `unreachable` ANSWER COUNTS AS ONE. The catalogue is what the
 * course picker is made of; if the first attempt lost a race with the sidecar coming up, the next
 * screen to ask should get a real attempt rather than a remembered empty list.
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
      /**
       * ⚠ `unreachable` IS A FAILURE WEARING A 200, AND ITS COURSES MUST NOT BE CACHED AS AN EMPTY
       * LIST. `/jolli/course` answers a whole catalogue shape whether or not it reached the gateway
       * — no credential, no tenant, a gateway that did not reply — and says which of the two
       * happened in `status`. Handing it to `setCatalog` would leave `inFlight` resolved, so one
       * lost race with the network would give the student an empty course picker for the life of
       * the process. So the collections are dropped and nothing is cached, exactly as the `catch`
       * below leaves a thrown error, and `status` is settled before `setCatalog` ever sees it.
       *
       * ⚠ THE IDENTITY ON IT IS NOT A FAILURE, THOUGH, AND DISCARDING IT WAS ONE. The server
       * resolves the viewer from the stored token BEFORE it asks whether the gateway is reachable,
       * and spreads it into every `unreachable` answer precisely so that a name on screen never
       * depends on the network. Throwing the whole reply away undid that at the last step: it blanked
       * the student's own name from the sidebar on every offline launch, and — because `loaded` never
       * flipped — left somebody who is signed OUT reading "Account" rather than "Not signed in".
       */
      if (catalog.status !== "ok") {
        setStore("viewer", catalog.viewer)
        setLoaded(true)
        inFlight = undefined
        return
      }
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
 *
 * ⚠ AND THE VIEWER, FOR THE SAME REASON ONLY SHARPER. This runs on sign-out and on switching
 * accounts; an identity that outlived its credential would leave the previous student's name in the
 * sidebar of somebody else's session.
 */
export function resetCatalog() {
  inFlight = undefined
  setLoaded(false)
  setStore(
    produce((draft) => {
      draft.courses = []
      draft.assistants = []
      draft.viewer = undefined
    }),
  )
  ModelTiers.set({})
  setGeneration((value) => value + 1)
}
