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

/** The subset of a catalogue these lookups read. Both renderers hold more than this. */
export interface CatalogLike {
  readonly courses: readonly Jolli.Course[]
  readonly assistants: readonly Jolli.Assistant[]
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
 * {@link blockedReason}. Only `open` may start.
 */
export function canStartSession(catalog: CatalogLike, courseId: string | undefined) {
  const course = courseById(catalog, courseId)
  if (!course || course.entryState !== "open") return false
  return assistantsForCourse(catalog, courseId).length > 0
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
 */
export function blockedReason(catalog: CatalogLike, course: Jolli.Course): CourseBlockedReason | undefined {
  if (course.entryState !== "open") return course.entryState
  if (assistantsForCourse(catalog, course.id).length === 0) return "no-assistants"
  return undefined
}

/**
 * ⚠ DERIVED FROM {@link Jolli.CourseEntryState} RATHER THAN LISTED AGAIN, so a new entry state is a
 * type error in both renderers rather than a course that renders as blocked with no reason beside
 * it. Each of them maps this exhaustively — to a dictionary key in the app, to English in the TUI.
 */
export type CourseBlockedReason = Exclude<Jolli.CourseEntryState, "open"> | "no-assistants"

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
