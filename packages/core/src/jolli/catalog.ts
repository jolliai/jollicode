/**
 * TURNING WHAT JOLLI EDU RETURNS INTO WHAT THIS PRODUCT RENDERS.
 *
 * ⚠ IT LIVES HERE RATHER THAN IN EITHER CALLER BECAUSE THERE ARE TWO OF THEM. The Electron main
 * process needs this to answer "does this student have a course at all" before it starts a server,
 * and the server needs it to answer `/jolli/course`. Two copies of the filter would be two answers
 * to "is this course mine".
 *
 * ⚠ EVERYTHING HERE IS PURE. Fetching is `api.ts`, caching is `cache.ts`; this module only decides.
 * That is what makes the rules below testable without a gateway.
 */
import { Jolli } from "@opencode-ai/schema/jolli"
import type { CatalogModel, CourseAssistantChoice, CourseListItem } from "./api"
import { providerIdFor, type JolliModel, type SupportedProtocol, SUPPORTED_PROTOCOLS } from "./gateway-config"

/**
 * Fallback protocol used when a course grant names a UUID no longer in the catalogue.
 * "anthropic" mirrors the pre-multi-protocol behaviour — a dead id used to key against the
 * single Jolli provider — and keeps `allowedModelIds` at least parseable rather than empty.
 * The picker still shows nothing for the id (the model row is gone), which is the honest
 * rendering of "your grant names a model that has been removed".
 */
const FALLBACK_PROTOCOL = "anthropic"

function supportedProtocolOf(protocol: string | undefined): SupportedProtocol {
  return SUPPORTED_PROTOCOLS.includes(protocol as SupportedProtocol)
    ? (protocol as SupportedProtocol)
    : FALLBACK_PROTOCOL
}

/**
 * TODAY, AS A TERM DATE. Mirrors jolliedu's `todayAsTermDate()` — local calendar fields, never an
 * ISO conversion, because the question "what day is it" has no timezone in this product.
 */
export function today(now: Date = new Date()): string {
  const month = `${now.getMonth() + 1}`.padStart(2, "0")
  const day = `${now.getDate()}`.padStart(2, "0")
  return `${now.getFullYear()}-${month}-${day}`
}

function dayBefore(date: string): string {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10)
}

/**
 * WHERE A COURSE STANDS TODAY. Ported from jolliedu's `courseEntryState()`
 * (`common/src/types/Course.ts:62`), and the three rules below are its, not ours:
 *
 * ⚠ COMPARISONS ARE LEXICAL ON `YYYY-MM-DD`, NEVER `Date` ARITHMETIC. Parsing to a `Date` drags a
 * timezone into a question that has none.
 *
 * ⚠ BOTH ENDS ARE INCLUSIVE. A course whose first day is today has started; one whose last day is
 * today has not finished.
 *
 * ⚠ `ended` GETS A DAY OF SLACK AND `not-yet` GETS NONE. There is no institution timezone anywhere
 * in the product, so a server answers this in its own; UTC−12…+14 spans 26 hours, and the margin
 * belongs on the end that LOCKS PEOPLE OUT. jolliedu's comment says **"do not tighten this"** — the
 * cost, a course that ended yesterday still reading as open, is intended.
 *
 * ⚠ `startsOn` IS NOT ON THE LIST SHAPE, so `not-yet` can never be produced from a course list
 * today — `CourseListItem` carries only `endsOn` (`CourseDetail` has both). The branch stays
 * because the field is coming; until it does, a course that has not started reads as `open`, which
 * is also jolliedu's own default posture (`courseAdmits()` admits `not-yet`).
 */
export function courseEntryState(
  course: { status: string; startsOn?: string | null; endsOn: string | null },
  now: string,
): Jolli.CourseEntryState {
  if (course.status === "archived") return "archived"
  if (course.status === "draft") return "draft"
  /**
   * ⚠ A STATUS THIS BUILD HAS NEVER HEARD OF IS NOT RUNNABLE. The wire decoder deliberately accepts
   * any string so that one new value cannot lock every student out of the app; the cost of that is
   * this branch, which has to choose. Refusing is the safe half: a course we cannot reason about
   * renders as unavailable and its row says so, where treating it as open would start sessions
   * under terms nobody here understands.
   */
  if (course.status !== "published") return "archived"
  if (course.startsOn != null && now < course.startsOn) return "not-yet"
  if (course.endsOn != null && course.endsOn < dayBefore(now)) return "ended"
  return "open"
}

/**
 * WHETHER THIS COURSE IS THE VIEWER'S OWN.
 *
 * ⚠ THE LIST ROUTE HANDS AN INSTITUTION ADMINISTRATOR EVERY COURSE IN THE ORG — jolliedu's own
 * comment: "Institution administrators are implicit staff of every course: they SEE the whole org's
 * course-kind spaces". Without this filter an administrator opening Jolli Code meets the whole
 * school's course list.
 *
 * ⚠ IT KEYS ON `viewerRole` RATHER THAN `staff[]` BECAUSE THE CLIENT DOES NOT KNOW ITS OWN USER ID.
 * Neither the list response nor anything we decode carries it, so membership has to be read off the
 * one role field — which is why the list below is a list of roles rather than a membership check.
 *
 * ⚠ `space-owner` IS ON THE LIST AND `space-manager` IS NOT, AND THAT ASYMMETRY IS THE WHOLE RULE.
 * The two `course-*` roles are not all of course membership: jolliedu seats THE PERSON WHO CREATED
 * THE COURSE as `space-owner` (`CourseRouter.ts`, the `addMember` beside the space insert), and
 * `course-instructor` is what a co-teacher added from the roster gets. Keying on the `course-*`
 * pair alone therefore admitted every co-teacher and refused every professor teaching a course they
 * made — the empty course list they met at launch was the course gate reading this answer.
 *
 * What the filter is actually for still holds, because the implicit role is `space-manager`
 * specifically (jolliedu's `IMPLICIT_COURSE_STAFF_ROLE`): an institution administrator with no
 * membership in a course resolves to that and is still dropped here. The one over-admission left is
 * a hand-written `spaces.admin` super-admin, whom `decideRoleBeforeMember` resolves to `space-owner`
 * on every space — rare, deliberate, and a far smaller error than locking professors out.
 *
 * ⚠ THE REAL FIX IS A FIELD, NOT THIS LIST. `viewerRole` conflates "my membership row says X" with
 * "I can see this because of who I am", and no amount of role-matching here can separate them. When
 * the gateway can say whether the viewer is a MEMBER, this collapses to that.
 */
export function isOwnCourse(course: Pick<CourseListItem, "viewerRole">): boolean {
  return (
    course.viewerRole === "course-student" ||
    course.viewerRole === "course-instructor" ||
    course.viewerRole === "space-owner"
  )
}

/**
 * Whether this course belongs in Jolli Code at all.
 *
 * ⚠ THE TWO CONDITIONS HERE REMOVE A COURSE FROM THE RESPONSE ENTIRELY, and they are the only two
 * that do. Being a draft, not having started, having ended or having no assistant does NOT — those
 * are shown and refused, because a list that omitted them could not say "your course opens on the
 * 2nd". See `Jolli.CourseEntryState`.
 */
export function isVisibleCourse(course: CourseListItem): boolean {
  return course.requiresCoding && isOwnCourse(course)
}

/**
 * THE COURSE'S PLACE ON THE DATAVIZ RAMP, DERIVED FROM ITS NUMERIC ID.
 *
 * ⚠ FROM THE ID, NOT THE NAME. jolliedu carries an `accent` column that nothing writes yet (always
 * 0) and derives the colour client-side from the id — it records that deriving from the NAME
 * repainted a course's every mark the moment somebody renamed it.
 */
export function accentOf(id: number): Jolli.Accent {
  return ((Math.abs(id) % 5) + 1) as Jolli.Accent
}

/** An unknown status is reported as archived, matching what {@link courseEntryState} concluded. */
function courseStatusOf(status: string): Jolli.Course["status"] {
  if (status === "draft" || status === "published" || status === "archived") return status
  return "archived"
}

const MODEL_TIER: Record<string, Jolli.ModelTier | undefined> = {
  Premium: "premium",
  // Basic maps to `economy` rather than `standard` because only `economy` produces a nudge;
  // `standard` is the silent middle and would be indistinguishable from "unclassified".
  Basic: "economy",
}

/**
 * An opencode model key for a Registry UUID the catalogue still carries.
 *
 * ⚠ THE PROVIDER SEGMENT IS PROTOCOL-QUALIFIED — one opencode provider per wire protocol
 * (see `providerIdFor` in `gateway-config.ts`), so the key has to name which one. A grant
 * pointing at a UUID whose model row is gone falls back to the anthropic-flavoured id, which
 * matches how the single-provider era wrote every key.
 */
const modelKey = (uuid: string, protocol: string) => `${providerIdFor(supportedProtocolOf(protocol))}/${uuid}`

/** Look up a UUID's protocol in the catalogue, or the safe default when the model is gone. */
const protocolOf = (models: ReadonlyMap<string, CatalogModel>, uuid: string): string =>
  supportedProtocolOf(models.get(uuid)?.protocol)

export function toCourse(input: {
  item: CourseListItem
  entryState: Jolli.CourseEntryState
  assistantIds: readonly string[]
}): Jolli.Course {
  return {
    id: String(input.item.id),
    code: input.item.code,
    title: input.item.name,
    kind: "code",
    ...(input.item.description ? { description: input.item.description } : {}),
    accent: accentOf(input.item.id),
    assistantIds: input.assistantIds,
    status: courseStatusOf(input.item.status),
    entryState: input.entryState,
    endsOn: input.item.endsOn,
    /**
     * ⚠ ALWAYS `private`, AND THAT IS NOT A DEFAULT WE PICKED. Jolli Edu models sharing as
     * per-session grants rather than as a course policy, so a new session starts with nothing
     * granted — `private` IS that state. There is no field to read: `CourseListItem`,
     * `CourseDetail` and `CourseSettings` all lack one.
     */
    chatSharing: "private",
  }
}

/**
 * ⚠ THE UUIDS ARE FILTERED AGAINST THE CATALOGUE, AND SILENTLY SO. A grant naming a model the
 * catalogue no longer carries would match nothing downstream and empty the student's picker with no
 * explanation — `fixtures.ts` warned about exactly this. Dropping the dead id keeps the rest of the
 * grant working; the caller logs what it dropped.
 *
 * ⚠ AN EMPTY `allowedModelIds` STAYS EMPTY, because empty means UNRESTRICTED — an assistant the
 * professor never restricted must keep behaving that way. The inverse case, a restricted grant
 * whose every id is dead, must NOT collapse into it; see the comment on the filter below.
 */
export function toAssistant(input: {
  choice: CourseAssistantChoice
  courseId: string
  isDefault: boolean
  models: ReadonlyMap<string, CatalogModel>
}): Jolli.Assistant {
  /**
   * ⚠ A GRANT THAT FILTERS DOWN TO NOTHING KEEPS ITS ORIGINAL IDS, AND THAT LOOKS WRONG UNTIL YOU
   * SEE WHAT THE ALTERNATIVE DOES. Empty means UNRESTRICTED downstream, so handing back `[]` for a
   * grant the professor deliberately restricted would open the entire tenant catalogue to the
   * student — the exact inverse of what they asked for. It happens for real: a provider whose
   * `isActive` flips to false takes its whole vendor group out of the index at once.
   *
   * Keeping the dead ids means nothing matches and the picker is empty, which is the honest
   * rendering of "every model your course allowed is currently unavailable".
   */
  const surviving = input.choice.allowedModelIds.filter((uuid) => input.models.has(uuid))
  const granted =
    surviving.length === 0 && input.choice.allowedModelIds.length > 0 ? input.choice.allowedModelIds : surviving
  const preferred = input.models.get(input.choice.modelId)
  return {
    id: String(input.choice.id),
    courseId: input.courseId,
    name: input.choice.name,
    kind: "code",
    blurb: input.choice.blurb,
    accent: accentOf(input.choice.id),
    ...(input.isDefault ? { isDefault: true } : {}),
    // Staff-only on the gateway, and the course prompt is injected server-side anyway.
    instructions: "",
    allowedModelIds: granted.map((uuid) => modelKey(uuid, protocolOf(input.models, uuid))),
    ...(preferred ? { modelId: modelKey(preferred.id, preferred.protocol) } : {}),
    guardrails: {
      neverGiveDirectAnswers: input.choice.worksThroughProblems,
      restrictToMaterials: input.choice.answersFromMaterialsOnly,
      showCitations: input.choice.showCitations,
      // jolliedu removed the cap on purpose: nothing refuses a turn over one.
      weeklyTokenCap: 0,
    },
    // The gateway serves no rubric; every assistant rests on the shape's own default.
    coaching: Jolli.STANDARD_RUBRIC,
    // The gateway has no skills concept. Empty means exactly none.
    skills: [],
    status: "live",
  }
}

/**
 * Every model the tenant offers, grouped by wire protocol.
 *
 * ⚠ GROUPED BY PROTOCOL BECAUSE `jolliBaseConfig` GENERATES ONE PROVIDER BLOCK PER PROTOCOL,
 * each with its own npm SDK. Handing back a flat list would force the config generator to
 * re-group, and duplicating that decision would let the two answers drift.
 *
 * ⚠ THE UUID IS THE OPENCODE MODEL ID, NOT THE NAME. Model names are not unique across
 * vendors, and each provider block's `models` object is keyed by id — two same-named models
 * would silently overwrite each other. The UUID is also what `allowedModelIds` already names,
 * so a grant matches with no translation step at all.
 */
export function toProviderModels(
  models: ReadonlyMap<string, CatalogModel>,
): Readonly<Record<string, ReadonlyArray<JolliModel>>> {
  const byProtocol: Record<string, JolliModel[]> = {}
  for (const model of models.values()) {
    const protocol = supportedProtocolOf(model.protocol)
    const bucket = (byProtocol[protocol] ??= [])
    bucket.push({
      id: model.id,
      name: model.category ? `${model.name} (${model.category})` : model.name,
      /** What actually goes upstream. */
      upstreamId: model.name,
    })
  }
  return byProtocol
}

/**
 * THE SNAPSHOT AS `/jolli/course` ANSWERS IT.
 *
 * ⚠ `entryState` IS COMPUTED HERE, EVERY TIME, AND NEVER READ FROM THE CACHE. It is a function of
 * today's date as much as of the course's fields: a course cached as `open` last night can be
 * `ended` this morning, and a cache that carried the verdict would hand the student yesterday's
 * answer with nothing to show for it. `now` is a parameter so a test can be a specific morning.
 *
 * ⚠ ASSISTANT ORDER IS THE GATEWAY'S AND MUST SURVIVE. `assistant-choices` withholds `isDefault`
 * and expresses the professor's default by sorting it first; `assistantIds` is built by walking the
 * list in order, so the first entry stays the default all the way to the picker.
 */
export function projectCatalog(
  snapshot: {
    readonly courses: readonly CourseListItem[]
    readonly assistants: Readonly<Record<string, readonly CourseAssistantChoice[]>>
    readonly models: readonly CatalogModel[]
  },
  now: string,
): Jolli.Catalog {
  const models = new Map(snapshot.models.map((model) => [model.id, model]))
  const courses: Jolli.Course[] = []
  const assistants: Jolli.Assistant[] = []
  const modelTiers: Record<string, Jolli.ModelTier> = {}
  for (const model of snapshot.models) {
    const tier = model.category ? MODEL_TIER[model.category] : undefined
    if (tier) modelTiers[modelKey(model.id, model.protocol)] = tier
  }

  for (const item of snapshot.courses) {
    const courseId = String(item.id)
    const choices = snapshot.assistants[courseId] ?? []
    for (const [index, choice] of choices.entries()) {
      assistants.push(toAssistant({ choice, courseId, isDefault: index === 0, models }))
    }
    courses.push(
      toCourse({
        item,
        entryState: courseEntryState(item, now),
        assistantIds: choices.map((choice) => String(choice.id)),
      }),
    )
  }

  /**
   * ⚠ `ok` IS NOT A GUESS HERE — HAVING A SNAPSHOT IS WHAT `ok` MEANS. This function is only ever
   * reached with a catalogue the gateway actually returned; every path that failed to ask one
   * answers `unreachable` before getting near it. See `Jolli.CatalogStatus`.
   */
  return { status: "ok", courses, assistants, modelTiers }
}
