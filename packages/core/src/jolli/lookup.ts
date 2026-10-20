/**
 * READING A PROJECTED CATALOGUE: WHICH COURSE, WHOSE ASSISTANT, WHICH MODELS.
 *
 * ⚠ IT IS SEPARATE FROM `catalog.ts` BECAUSE IT FACES THE OTHER WAY. That module turns what the
 * gateway returns INTO a {@link Jolli.Catalog}; this one only answers questions ABOUT one. Keeping
 * the producer apart from its consumers is what lets a surface that never speaks to a gateway —
 * both renderers read their catalogue back off `/jolli/course` — use these without dragging the
 * wire decoders in behind them.
 *
 * ⚠ AND IT IS SHARED BECAUSE THERE ARE TWO RENDERERS NOW. The desktop app and the TUI both have to
 * answer "may this student start a session in this course" and "may this assistant run this
 * model", and a student must not get two answers depending on which one they opened. Same argument
 * `catalog.ts` makes for itself at the top of that file, one layer up.
 *
 * ⚠ EVERY FUNCTION TAKES THE CATALOGUE RATHER THAN CLOSING OVER ONE. The app keeps it in a Solid
 * store and the TUI in a context of its own; a module that owned the data would have to pick one
 * of those and make the other wrong.
 */
export * as Lookup from "./lookup"

import { Jolli } from "@opencode-ai/schema/jolli"
import { parseOrgScopedId } from "./org-scoped-id"

/**
 * HOW RECENT A CATALOGUE REFRESH HAS TO BE FOR A PICKER BEING OPENED TO LET IT STAND.
 *
 * ⚠ ONLY FOR THAT RE-ASK. Every refresh past the server's cache is a full gateway load — courses,
 * models, then each course's assistants — and opening and closing a menu a few times would make one
 * each; somebody told the list is wrong (a refused Start, "check again") still asks at once.
 */
export const RECHECK_INTERVAL_MS = 30_000

/** The subset of a catalogue these lookups read. Both renderers hold more than this. */
export interface CatalogLike {
  readonly courses: readonly Jolli.Course[]
  readonly assistants: readonly Jolli.Assistant[]
}

/**
 * A PICKER'S COURSES, ONE GROUP PER ORG AND EACH HEADED BY ITS ORG'S NAME, IN THE LIST'S ORDER.
 *
 * ⚠ ONLY WHEN THE STUDENT'S COURSES SPAN MORE THAN ONE ORG. Course ids collide across orgs and so do
 * course codes — two schools' "CS 101" — so a list that mixes orgs has to say whose each row is. A
 * list in one org is one unlabelled group, as it was before courses came from every org.
 *
 * ⚠ GROUPED BY THE ORG THE ID NAMES, NOT BY ITS DISPLAY NAME. Two orgs can share an institution and
 * org name; counted by name they read as one org and their two "CS 101" rows sat side by side with
 * nothing to tell them apart. A name two groups share is followed by the slugs that do differ.
 *
 * ⚠ THE INSTITUTION FIRST, THE ORG ONLY WHEN IT SAYS SOMETHING MORE. An institution whose one org
 * shares its name would otherwise read "Westfield · Westfield".
 */
export function orgGroups(courses: readonly Jolli.Course[]) {
  const byOrg = Array.from(
    Map.groupBy(courses, (course) => {
      const org = parseOrgScopedId(course.id)?.org
      return org ? `${org.tenantSlug}/${org.orgSlug}` : ""
    }),
  )
  if (byOrg.length < 2) return [{ label: undefined, rows: [...courses] }]
  const named = byOrg.map(([slugs, rows]) => {
    const org = rows[0].org
    if (!org) return { slugs, label: slugs || undefined, rows }
    const label = org.orgName === org.institutionName ? org.institutionName : `${org.institutionName} · ${org.orgName}`
    return { slugs, label, rows }
  })
  return named.map((group) => ({
    label:
      group.slugs && named.filter((other) => other.label === group.label).length > 1
        ? `${group.label} (${group.slugs})`
        : group.label,
    rows: group.rows,
  }))
}

export function courseById(catalog: CatalogLike, id: string | undefined) {
  if (!id) return undefined
  return catalog.courses.find((course) => course.id === id)
}

export function assistantById(catalog: CatalogLike, id: string | undefined) {
  if (!id) return undefined
  return catalog.assistants.find((assistant) => assistant.id === id)
}

/**
 * THE COURSE'S ASSISTANTS, IN THE COURSE'S OWN ORDER.
 *
 * ⚠ DRIVEN BY `assistantIds` RATHER THAN BY FILTERING THE FLAT LIST, because the order is the
 * professor's: the gateway withholds an `isDefault` flag and expresses the default by sorting it
 * first, so a filter that re-ordered would quietly lose their choice.
 */
export function assistantsForCourse(catalog: CatalogLike, courseId: string | undefined) {
  const course = courseById(catalog, courseId)
  if (!course) return []
  return course.assistantIds
    .map((id) => assistantById(catalog, id))
    .filter((assistant): assistant is Jolli.Assistant => !!assistant)
}

/** The assistant a student gets when they pick nobody: the professor's default, which sorts first. */
export function defaultAssistantFor(catalog: CatalogLike, courseId: string | undefined) {
  const list = assistantsForCourse(catalog, courseId)
  return list.find((assistant) => assistant.isDefault) ?? list[0]
}

/**
 * Whether a session can actually be started in this course today.
 *
 * ⚠ IT ASKS `entryState`, NOT `status`. A course can be published and still be over, or not have
 * begun; the server computes that against today's date and each case gets its own sentence in
 * {@link blockedReason}. Only `open` may start — and, for a student, only with an assistant open
 * at `now` (see {@link startableAssistants}).
 */
export function canStartSession(catalog: CatalogLike, courseId: string | undefined, now: Date) {
  const course = courseById(catalog, courseId)
  if (!course) return false
  return blockedReason(catalog, course, now) === undefined
}

/**
 * WHAT IS IN THE WAY OF STARTING THIS COURSE, OR nothing when nothing is.
 *
 * ⚠ IT ANSWERS WITH A CODE AND NOT A SENTENCE, BECAUSE THE TWO RENDERERS CANNOT SHARE THE WORDS.
 * The desktop must put visible copy through its i18n dictionary (`packages/app/AGENTS.md` forbids
 * hardcoded English outright); the TUI has no dictionary at all and keeps English. A shared module
 * that answered in one language would be choosing for both, and the one it chose against would have
 * to unpick the sentence to translate it.
 *
 * ⚠ EVERY REASON STAYS ITS OWN VALUE. They lead to different next actions — wait for the teacher,
 * wait for term, ask the teacher, nothing — so collapsing them into one "unavailable" throws away
 * the only useful part. That is a promise about this return type, not about any one renderer.
 *
 * ⚠ `not-yet` CANNOT HAPPEN YET AND IS ANSWERED ANYWAY. The course list the gateway serves carries
 * `endsOn` but no `startsOn`, so the server can never conclude a course has not begun. When that
 * field arrives this starts firing with no further change here — do not delete it as dead.
 *
 * ⚠ `no-open-assistants` IS A STUDENT'S ANSWER ONLY. The course has assistants, but none can start
 * a chat at `now`; staff are exempt from the windows on the gateway, so for them it never fires.
 */
export function blockedReason(catalog: CatalogLike, course: Jolli.Course, now: Date): CourseBlockedReason | undefined {
  if (course.entryState !== "open") return course.entryState
  const assistants = assistantsForCourse(catalog, course.id)
  if (assistants.length === 0) return "no-assistants"
  if (startableAssistants(course, assistants, now).length === 0) return "no-open-assistants"
  return undefined
}

/**
 * ⚠ DERIVED FROM {@link Jolli.CourseEntryState} RATHER THAN LISTED AGAIN, so a new entry state is a
 * type error in both renderers rather than a course that renders as blocked with no reason beside
 * it. Each of them maps this exhaustively — to a dictionary key in the app, to English in the TUI.
 */
export type CourseBlockedReason = Exclude<Jolli.CourseEntryState, "open"> | "no-assistants" | "no-open-assistants"

/**
 * WHERE `now` FALLS IN AN ASSISTANT'S AVAILABILITY WINDOW.
 *
 * ⚠ THE START IS INSIDE THE WINDOW AND THE END IS NOT, exactly as Jolli Edu's
 * `availabilityWindowPhase` decides it. A boundary drawn differently here would offer a chat for
 * the one instant the gateway refuses it. A missing or unparseable side is unbounded.
 */
export function windowPhase(assistant: Jolli.Assistant, now: Date): WindowPhase {
  const at = now.getTime()
  const startsAt = instant(assistant.startsAt)
  if (startsAt !== undefined && at < startsAt) return "before"
  const endsAt = instant(assistant.endsAt)
  return endsAt !== undefined && at >= endsAt ? "after" : "open"
}

export type WindowPhase = "before" | "open" | "after"

/**
 * Whether a new chat with this assistant may start at `now`: chat is enabled and the window is open.
 *
 * ⚠ IT SAYS NOTHING ABOUT A CHAT THAT ALREADY EXISTS. The gateway lets one continue before the
 * window opens and refuses it only after the window closes, so an existing session is judged by
 * {@link windowPhase} alone.
 */
export function isDirectlyStartable(assistant: Jolli.Assistant, now: Date) {
  return assistant.directChatEnabled !== false && windowPhase(assistant, now) === "open"
}

/**
 * THE ASSISTANTS A NEW SESSION IN THIS COURSE MAY OFFER AT `now`, IN THE COURSE'S ORDER.
 *
 * ⚠ STAFF SEE ALL OF THEM. The gateway exempts a course's teachers from the windows so they can
 * try an assistant before it opens; filtering their picker would hide exactly what they came to try.
 *
 * ⚠ A NEW-SESSION FILTER ONLY. The catalogue keeps every assistant, so a session bound to one that
 * has since closed still shows its name — {@link assistantsForCourse} answers for that.
 */
export function startableAssistants(course: Jolli.Course, assistants: readonly Jolli.Assistant[], now: Date) {
  if (course.isStaff) return [...assistants]
  return assistants.filter((assistant) => isDirectlyStartable(assistant, now))
}

/**
 * The one to select from an already-filtered list: the preferred one if it survived the filter,
 * otherwise the first.
 *
 * ⚠ THE FIRST OF THE FILTERED LIST IS NOT "THE DEFAULT". `isDefault` stays on the professor's first
 * assistant; one standing in for it while it is closed is selected but not labelled as the default.
 */
export function pickAssistant(filtered: readonly Jolli.Assistant[], preferredId?: string) {
  return filtered.find((assistant) => assistant.id === preferredId) ?? filtered[0]
}

/**
 * THE INSTANT A WINDOW CLOCK SHOULD NEXT TICK: the soonest start or end of these assistants' windows
 * still ahead of `now`; undefined when there is none.
 *
 * ⚠ ONLY A START GETS THE GRACE, AND THAT ASYMMETRY IS THE POINT. The grace is for the gateway's
 * clock, which may trail this one. Late on a start, this opens an assistant a moment after the
 * gateway would — the safe side. Late on an end, it would keep offering a chat for that moment
 * while the gateway already refuses it, which is exactly what {@link windowPhase} exists to prevent;
 * so an end ticks on the boundary itself and closes here no later than there.
 */
export function nextWindowBoundaryAt(assistants: readonly Jolli.Assistant[], now: Date) {
  const at = now.getTime()
  return assistants
    .flatMap((assistant) => [
      { at: instant(assistant.startsAt), grace: BOUNDARY_GRACE_MS },
      { at: instant(assistant.endsAt), grace: 0 },
    ])
    .filter((boundary): boundary is { at: number; grace: number } => boundary.at !== undefined && boundary.at > at)
    .reduce<number | undefined>((min, boundary) => Math.min(min ?? Infinity, boundary.at + boundary.grace), undefined)
}

/**
 * CALL `onDue` ONCE THE WALL CLOCK REACHES `due`; answers the function that cancels it.
 *
 * ⚠ ONE `setTimeout` FOR THE WHOLE WAIT WOULD BE LATE BY HOWEVER LONG THE MACHINE SLEPT. Timers run
 * on a monotonic clock that stops while it is suspended, so a lid closed at 18:00 over a window
 * ending at 20:00 would leave the assistant offered until two waking hours after the lid opened. The
 * wait is cut into checks against `Date.now()` instead, at most {@link WAKE_CHECK_MS} apart; a check
 * that is not due only re-arms, so nothing downstream re-runs for it. The same cap keeps a far
 * boundary under `setTimeout`'s ceiling, past which it would fire at once.
 */
export function watchBoundary(due: number, onDue: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const check = () => {
    if (Date.now() >= due) return onDue()
    timer = setTimeout(check, Math.min(due - Date.now(), WAKE_CHECK_MS))
  }
  check()
  return () => clearTimeout(timer)
}

const BOUNDARY_GRACE_MS = 2_000
const WAKE_CHECK_MS = 60_000

function instant(iso: string | null | undefined) {
  if (!iso) return undefined
  const at = Date.parse(iso)
  return Number.isNaN(at) ? undefined : at
}

/**
 * SPLIT A GRANT KEY INTO THE PAIR THE MODEL PICKERS SPEAK IN.
 *
 * ⚠ IT LIVES BESIDE THE GRANT CHECK BECAUSE THE KEY FORMAT DOES. A grant names a model as
 * `<providerID>/<modelID>`, and several callers were each re-deriving that split from `indexOf`;
 * one of them reaching for `lastIndexOf` instead would be a silent mismatch rather than a type
 * error.
 *
 * ⚠ THE FIRST SLASH IS THE SEPARATOR, NOT THE LAST. A provider id never contains one; a model id
 * may (`vendor/family/name`), so splitting from the right would move part of the model into the
 * provider.
 */
export function parseModelKey(key: string | undefined) {
  if (!key) return undefined
  const slash = key.indexOf("/")
  if (slash <= 0) return undefined
  return { providerID: key.slice(0, slash), modelID: key.slice(slash + 1) }
}

/**
 * ⚠ AN EMPTY GRANT MEANS UNRESTRICTED. A course that has not thought about model access must behave
 * exactly like the product did before this existed — the alternative, an empty picker, reads as a
 * broken application rather than as an unconfigured course.
 *
 * ⚠ AND IT IS A DISPLAY FILTER, NOT ENFORCEMENT. A student who cannot see a model cannot pick one,
 * which is all a client can honestly claim. The gateway is what refuses a model a course did not
 * grant; nothing in either renderer should be mistaken for that.
 */
export function isModelAllowed(allowed: readonly string[], providerID: string, modelID: string) {
  if (allowed.length === 0) return true
  return allowed.includes(`${providerID}/${modelID}`)
}
