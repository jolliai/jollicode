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

import { batch, createRoot, createSignal } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { Lookup } from "@opencode-ai/core/jolli/lookup"
import type { CourseBinding } from "@opencode-ai/core/jolli/binding"
import { ModelTiers } from "./model-tier"
import { createWindowClock } from "./window-clock"
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
/**
 * ⚠ BUMPED BY EVERY ANSWER, BECAUSE THE ARRAYS NO LONGER SAY ONE LANDED. {@link setCatalog}
 * reconciles into the arrays it already has, so a reader that tracked `store.assistants` by
 * reference — the window clock resets on a new catalogue — never heard of another.
 */
const [revision, setRevision] = createSignal(0)

/** Bumped by {@link resetCatalog}; read by whoever owns the fetch so a reset actually re-asks. */
export const catalogGeneration = generation

/** The generation {@link refreshCatalog} last raised to — the one load that asks past the server's cache. */
let refreshed: number | undefined

/**
 * WHETHER THIS GENERATION'S LOAD SHOULD ASK FOR A FRESH CATALOGUE (`/jolli/course?fresh=true`).
 *
 * ⚠ ONLY A {@link refreshCatalog} GENERATION DOES. A reset or a first load is happy with the
 * server's snapshot; a refresh is somebody who has just been told it is wrong.
 */
export function catalogRefreshed(count: number) {
  return count === refreshed
}

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
 *
 * ⚠ RECONCILED BY ID, NOT ASSIGNED. Every answer is new objects, and opening either picker asks for
 * one while the menu is open; assigned, each course and assistant became a different object, every
 * `For` keyed on it rebuilt its rows, and the keyboard highlight went with them. Reconciled, a course
 * or assistant that is still there keeps its object and only what changed about it updates.
 */
export function setCatalog(catalog: Catalog) {
  const payload = catalog as Partial<Catalog> | undefined
  // ⚠ Key by key, not over the whole store: reconciled at the root, a field added to the store later
  // and not listed here would be deleted by every answer, with nothing to say so.
  batch(() => {
    setStore("courses", reconcile(Array.isArray(payload?.courses) ? payload.courses : [], { key: "id" }))
    setStore("assistants", reconcile(Array.isArray(payload?.assistants) ? payload.assistants : [], { key: "id" }))
    setStore(
      produce((draft) => {
        draft.viewer = payload?.viewer
      }),
    )
    setRevision((value) => value + 1)
  })
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

/**
 * ⚠ `now` DEFAULTS TO {@link windowNow}, SO A SCREEN RE-ASKS WHEN AN ASSISTANT'S WINDOW OPENS OR
 * CLOSES. A caller in a render or a memo tracks the clock just by calling this; the parameter is
 * there for a test, or for a caller that must not track it.
 */
export function canStartSession(courseId: string | undefined, now = windowNow()): boolean {
  return Lookup.canStartSession(store, courseId, now)
}

/** Every assistant the catalogue holds, across every course — what the window clock is armed from. */
export function allAssistants(): readonly Assistant[] {
  return store.assistants
}

/**
 * THE TIME ASSISTANT WINDOWS ARE JUDGED BY, TICKING ONLY AT A BOUNDARY — see `window-clock.ts`.
 *
 * ⚠ ONE CLOCK FOR THE WHOLE APP, BESIDE THE CATALOGUE IT IS ARMED FROM. It used to live in each
 * `CourseSessionProvider`, and two of those are mounted on the draft route — two timers that could
 * disagree around a boundary — while the sidebar, which sits outside both, fell back to a
 * `new Date()` read once: its "+" stayed disabled after a window opened, and stayed enabled after
 * one closed. Armed from every assistant, because the course picker words every course's blocked
 * reason off it.
 *
 * ⚠ A ROOT NOBODY DISPOSES, ON PURPOSE. It lives as long as the catalogue it watches, which is the
 * life of the page.
 */
export const windowNow = createRoot(() =>
  createWindowClock(() => {
    // A new catalogue is a new revision, not a new array — see `revision`.
    revision()
    return allAssistants()
  }),
)

/**
 * THE ASSISTANTS A NEW SESSION IN THIS COURSE MAY OFFER AT `now`: the open ones for a student, every
 * one for staff.
 *
 * ⚠ A FILTER FOR NEW SESSIONS ONLY. {@link assistantsForCourse} still answers with every assistant,
 * so a live session bound to one that has since closed keeps its name on screen.
 */
export function newSessionAssistants(courseId: string | undefined, now = windowNow()): Assistant[] {
  const course = courseById(courseId)
  if (!course) return []
  return Lookup.startableAssistants(course, assistantsForCourse(courseId), now)
}

/**
 * THE DRAFT A NEW SESSION IN THIS COURSE STARTS FROM: the preferred assistant if it may start at
 * `now`, otherwise the first that may.
 *
 * ⚠ THE FIRST THAT MAY START IS THE PROFESSOR'S DEFAULT WHENEVER THE DEFAULT IS OPEN, because it
 * sorts first. When it is closed the next one stands in for it — selected, but still not the
 * default, which stays where the server put it.
 */
export function draftBinding(courseId: string, assistantId?: string, now = windowNow()): CourseBinding | undefined {
  const chosen = Lookup.pickAssistant(newSessionAssistants(courseId, now), assistantId)
  if (!chosen) return undefined
  return { courseId, assistantId: chosen.id }
}

/**
 * Whether a live session's assistant has closed for the person reading it — a student, past the end
 * of the window. Staff are exempt on the gateway; before the window opens an existing chat may
 * still continue, so only `after` counts.
 */
export function closedForViewer(course: Course | undefined, assistant: Assistant | undefined, now = windowNow()) {
  if (!course || !assistant || course.isStaff) return false
  return Lookup.windowPhase(assistant, now) === "after"
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
 * ⚠ A COURSE WHOSE AGENTS ARE ALL OUTSIDE THEIR WINDOWS STAYS LISTED. Only a new session is refused
 * there; the student's chats in it stay readable, and this row is where they are filed — hiding it
 * hid them. Its "+" still goes by {@link canStartSession}, so nothing new can be started from it.
 *
 * ⚠ IT IS NOT WHAT THE PICKER USES, DELIBERATELY. `prompt-course-selector` lists every enrolment
 * with its `blockedReason` spelled out, because refusing a course a student went looking for is
 * information; a filter row in a 300px column that they did not ask for is not.
 */
export function listedCourses(): Course[] {
  const all = enrolledCourses()
  const listed = all.filter((course) => {
    const reason = blockedReason(course)
    return reason === undefined || reason === "no-open-assistants"
  })
  return listed.length > 0 ? listed : all
}

/** What is in the way of starting this course, as the code the picker puts into words. */
export function blockedReason(course: Course, now = windowNow()) {
  return Lookup.blockedReason(store, course, now)
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
 * ASK FOR THE CATALOGUE AGAIN WITHOUT FORGETTING THE ONE ON SCREEN. For a student who pressed
 * refresh because their professor changed something a minute ago.
 *
 * ⚠ IT IS NOT {@link resetCatalog}, AND THE DIFFERENCE IS THE WHOLE REASON IT EXISTS. That one
 * empties `courses` on the way out, which is right when the account is going away and wrong here:
 * the sidebar gates its Courses section on having any, so clearing them unmounts the section —
 * along with the refresh control the student's cursor is still on — and paints it back a round trip
 * later. Nothing is dropped here; `setCatalog` overwrites when the answer lands.
 *
 * ⚠ THE GENERATION IS BUMPED RATHER THAN THE FETCH CALLED, because this module does not own the
 * fetch. `useJolliCatalog` keys its effect on the generation, so raising it is what makes the
 * caller that DOES own it ask again — and `inFlight` is keyed by the same counter, so the new key
 * cannot be deduped against the load it is replacing.
 *
 * ⚠ AND IT REACHES PAST THE SERVER'S OWN CACHE, which is a five minute snapshot
 * (`core/jolli/cache.ts`). Every caller is somebody told the list is wrong — a refused Start, a
 * picker opened to choose again, the sidebar's refresh — and re-reading that snapshot handed back
 * the assistant whose window had just closed, leaving the draft on it.
 */
export function refreshCatalog() {
  refreshedAt = Date.now()
  refreshed = generation() + 1
  setGeneration(refreshed)
}

/** When {@link refreshCatalog} last ran, for {@link recheckCatalog}. */
let refreshedAt = Number.NEGATIVE_INFINITY

/**
 * {@link refreshCatalog}, unless one ran in the last `Lookup.RECHECK_INTERVAL_MS`. For a picker
 * being opened, which re-asks in case the list moved since launch.
 */
export function recheckCatalog() {
  if (Date.now() - refreshedAt < Lookup.RECHECK_INTERVAL_MS) return
  refreshCatalog()
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
