export * as Jolli from "./jolli"

import { Schema } from "effect"
import { optional } from "./schema"

/**
 * THE COURSE AND ASSISTANT SHAPES THE JOLLI GATEWAY SERVES, AS THIS REPO'S OWN DOMAIN TYPES.
 *
 * ⚠ THESE ARE OURS, NOT THE GATEWAY'S WIRE SHAPES. `packages/core/src/jolli/api.ts` decodes what
 * Jolli Edu actually returns (`CourseListItem`, `CourseAssistantChoice`, `AgentModelProvider`) and
 * maps it onto these. Keeping the two apart is what makes "the gateway changed a field" a diff in
 * one file rather than a hunt: everything above `api.ts` speaks only this module.
 *
 * ⚠ AND THEY LIVE IN SCHEMA BECAUSE THREE PACKAGES NEED THEM. `packages/opencode` declares the
 * `/jolli/course` endpoint with them, `packages/core` produces them, and `packages/app` renders
 * them — AGENTS.md puts anything shared that way in Schema, which depends on nothing.
 *
 * ⚠ THE SHAPES WERE PORTED FROM THE PROFESSOR-FACING MOCK (jolli-edu-design, `app/src/data/types.ts`)
 * RATHER THAN INVENTED, and that is still the rule when a field is added. A professor configures a
 * course on that surface and a student meets the result on this one; two definitions of Course
 * would be two products.
 *
 * ⚠ IT IS A TRIM, NOT A COPY. The web product's shapes carry fields nothing here reads — rosters,
 * materials, passcodes, term dates, billing. They are omitted rather than stubbed, so a reader
 * cannot mistake an unused field for one this surface honours.
 *
 * ⚠ WHICH IS WHY THE FIELDS MARKED "ALWAYS EMPTY TODAY" BELOW ARE THE EXCEPTION AND SAY SO. They
 * are not unread fields; they have working consumers in `packages/app` (`sharing.ts`,
 * `coaching.ts`, `slash-groups.ts`) and a gateway that does not produce them yet. Consumer built,
 * producer pending — not a stub.
 *
 * Ported from `packages/app/src/jolli/types.ts`, whose comments recorded the invariants below.
 */

/**
 * WHO MAY READ A STUDENT'S SESSION.
 *
 * ⚠ `staff-required` IS NOT A STRICTER `staff`, IT IS A LOCK, and that distinction is the whole
 * reason this is a three-member union rather than a boolean plus a flag. Under `staff` a student
 * may make one session private; under `staff-required` that control is refused and says who
 * refused it.
 *
 * ⚠ THE GATEWAY HAS NO EQUIVALENT TODAY, so every course arrives `private` — see the mapping in
 * `packages/core/src/jolli/api.ts`. Jolli Edu models sharing as per-session grants
 * (`ConversationPersonShare` / `ConversationClassShare`) rather than as a course policy, and
 * `private` is that model's "nothing granted yet" rather than a default we picked.
 */
export const ChatSharing = Schema.Literals(["private", "staff", "staff-required"]).annotate({
  identifier: "Jolli.ChatSharing",
})
export type ChatSharing = typeof ChatSharing.Type

/**
 * WHAT A COURSE MAY HAND ITS STUDENTS. A `code` course hands them this application.
 *
 * ⚠ NEVER DERIVED FROM A SUBJECT. "CS" in a course code names a department, and a computer science
 * department runs theory courses that never open an editor. It comes from the gateway's
 * `requiresCoding`, which the professor sets.
 */
export const CourseKind = Schema.Literals(["standard", "code"]).annotate({ identifier: "Jolli.CourseKind" })
export type CourseKind = typeof CourseKind.Type

/**
 * WHAT AN ASSISTANT IS FOR, WHICH DECIDES WHETHER IT BELONGS IN THIS APPLICATION AT ALL.
 *
 * ⚠ THIS FIELD LEADS THE WEB MOCK RATHER THAN PORTING FROM IT. `jolli-edu-design` has no assistant
 * kind — a professor there builds one assistant and it answers anywhere. The desktop is the surface
 * that makes the distinction necessary: an assistant written to answer "when is this due" has no
 * business being offered inside an editor, and a student who picks it gets a session that cannot do
 * the thing they opened the app to do. The web side gains the same field later; until it does, this
 * is the one shape here that is ahead of that one.
 */
export const AssistantKind = Schema.Literals(["standard", "code"]).annotate({ identifier: "Jolli.AssistantKind" })
export type AssistantKind = typeof AssistantKind.Type

/**
 * WHERE A COURSE IS IN ITS LIFE, AND THEREFORE WHETHER A SESSION MAY START IN IT.
 *
 * ⚠ ONLY `open` IS SELECTABLE; THE OTHER FOUR ARE SHOWN AND REFUSED. A list that simply omitted
 * them could not say "your course opens on the 2nd" — and those four want four different sentences,
 * because the student's next move differs for each (wait for the teacher, wait for term, ask the
 * teacher, nothing).
 *
 * ⚠ IT IS A FUNCTION OF TODAY'S DATE, so it is computed per response and never cached. Mirrors
 * `courseEntryState()` in jolliedu (`common/src/types/Course.ts`).
 */
export const CourseEntryState = Schema.Literals(["open", "draft", "not-yet", "ended", "archived"]).annotate({
  identifier: "Jolli.CourseEntryState",
})
export type CourseEntryState = typeof CourseEntryState.Type

/**
 * A SESSION'S ACTUAL READERS, WHICH IS NOT THE SAME TYPE AS A COURSE'S POLICY.
 *
 * ⚠ TWO INDEPENDENT FACTS, NOT ONE ENUM, AND THE WEB MOCK IS SHAPED THE SAME WAY: a conversation
 * there carries `staffShared` alongside `shares` (a list that may include the course-wide
 * sentinel). A student can hand a session to their professor, to their classmates, to both, or to
 * nobody, and collapsing that into one ordered value would make "shared with the class but not with
 * staff" unrepresentable — which is the state a study group actually wants.
 *
 * ⚠ `ChatSharing` DECIDES WHERE THIS STARTS AND NOTHING MORE. A policy governs what a NEW session
 * begins as; from then on visibility is a fact about the session. See `defaultSessionSharing`.
 */
export interface SessionSharing extends Schema.Schema.Type<typeof SessionSharing> {}
export const SessionSharing = Schema.Struct({
  /** Course staff can read it. Starts from the course policy, then it is the student's to toggle. */
  staff: Schema.Boolean,
  /** Everyone enrolled in the course. A MEMBERSHIP, not a link, so it follows the roster. */
  everyone: Schema.Boolean,
}).annotate({ identifier: "Jolli.SessionSharing" })

/**
 * THE COURSE'S PLACE ON THE DATAVIZ RAMP. Identity, not status: it is true of the course on its
 * best day, which is why a kind chip is tinted with it and a lifecycle chip is not.
 *
 * ⚠ DERIVED FROM THE GATEWAY'S NUMERIC ID, NOT FROM THE NAME. jolliedu carries an `accent` column
 * that nothing writes yet (always 0), and its own client derives the colour from the id — it
 * records that deriving from the NAME repainted a course's every mark the moment it was renamed.
 */
export const Accent = Schema.Literals([1, 2, 3, 4, 5]).annotate({ identifier: "Jolli.Accent" })
export type Accent = typeof Accent.Type

export interface Course extends Schema.Schema.Type<typeof Course> {}
export const Course = Schema.Struct({
  /** `String()` of the gateway's numeric id. Everything above `api.ts` sees only strings. */
  id: Schema.String,
  /** What a student calls it out loud. "CS 310". */
  code: Schema.String,
  title: Schema.String,
  kind: CourseKind,
  description: Schema.String.pipe(optional),
  accent: Accent,
  /**
   * ⚠ ORDER IS MEANINGFUL: the gateway's own order, and its first entry IS the default assistant.
   * `assistant-choices` deliberately withholds an `isDefault` flag and expresses the default by
   * sorting it first, so re-sorting this loses the professor's choice.
   *
   * ⚠ A COURSE MAY LEGITIMATELY HAVE NONE — a draft nobody has configured yet. That empty branch is
   * the one worth reviewing.
   */
  assistantIds: Schema.Array(Schema.String),
  status: Schema.Literals(["draft", "published", "archived"]),
  /** Whether a session may start here. See {@link CourseEntryState}. */
  entryState: CourseEntryState,
  /** `YYYY-MM-DD`, for the "ended"/"opens on" lines. Null when the course has no end date. */
  endsOn: Schema.NullOr(Schema.String),
  /** The default a NEW session starts at. A session's own visibility is a fact about the session. */
  chatSharing: ChatSharing,
}).annotate({ identifier: "Jolli.Course" })

/**
 * WHAT AN ASSISTANT MAY NOT DO, WHICH IS THE CONTRACT A PROFESSOR ACTUALLY SETS.
 *
 * ⚠ CARRIED BUT NOT ENFORCED HERE. The gateway enforces these; this surface shows them so a student
 * knows the terms of the assistant they picked. Do not add a code path that pretends to enforce one
 * locally.
 *
 * ⚠ EVERY SWITCH RESTRICTS, SO OFF IS THE PERMISSIVE RESTING STATE. That is the opposite direction
 * to {@link CoachingRubric}, whose switches say what the coach may HELP with — see the note there.
 */
export interface AssistantGuardrails extends Schema.Schema.Type<typeof AssistantGuardrails> {}
export const AssistantGuardrails = Schema.Struct({
  neverGiveDirectAnswers: Schema.Boolean,
  restrictToMaterials: Schema.Boolean,
  showCitations: Schema.Boolean,
  /**
   * Zero means uncapped, and zero is all the gateway can produce.
   * jolliedu removed this field on purpose: nothing refuses a turn over a cap, so a setting a
   * teacher could change and nothing would honour was worse than no setting.
   */
  weeklyTokenCap: Schema.Finite,
}).annotate({ identifier: "Jolli.AssistantGuardrails" })

/**
 * WHAT A COACHING NUDGE BESIDE THIS ASSISTANT'S ANSWERS MAY BE ABOUT.
 *
 * ⚠ THE PROFESSOR SETS THIS IN THE WEB PRODUCT AND THIS SURFACE ONLY APPLIES IT — there is no
 * builder here and there should not be one. A control that edited one would be this application
 * inventing a professor. The gateway does not serve it yet, so every assistant arrives with
 * `STANDARD_RUBRIC`.
 *
 * ⚠ THE SWITCHES DECIDE WHICH DERIVATIONS MAY RUN, NEVER WHAT A NUDGE SAYS. The web mock
 * (`app/src/components/chat/coach.ts`) spends its header on why, and it is worth repeating because
 * this port adds a model to the loop: its own retrospective recorded four of its five first-draft
 * cards reading well and being false. A rubric selects; it does not write.
 *
 * ⚠ ALL THREE REST ON, WHICH IS THE OPPOSITE OF {@link AssistantGuardrails} AND DELIBERATE. A
 * guardrail RESTRICTS the assistant, so off is its permissive resting state. A coaching switch is
 * what the coach may HELP with, so off is the restrictive direction and all-on is the generous one.
 * {@link STANDARD_RUBRIC} is that resting state.
 *
 * ⚠ ALL THREE OFF IS A REAL CONFIGURATION AND NOT A NULL STATE: this assistant is not coached, and
 * what renders is nothing at all rather than a nudge nobody wrote.
 */
export interface CoachingRubric extends Schema.Schema.Type<typeof CoachingRubric> {}
export const CoachingRubric = Schema.Struct({
  /** Thin prompts, and asking for the answer outright when the assistant may never give one. */
  coachTheQuestion: Schema.Boolean,
  /**
   * HOW THE WORK WAS DONE, READ OFF TOOL CALLS.
   *
   * ⚠ THIS IS THE WEB MOCK'S `pointAtTheMaterials` REPLACED RATHER THAN RENAMED, AND THE SWAP IS
   * WHY THIS IS NOT A COPY. There, the third axis is "you named a document and did not attach it" —
   * an essay-shaped failure, against a library of course materials. Here a student is in a
   * repository: the equivalent evidence is the turn's tool calls, which the web mock reads only
   * behind its `process-coaching` skill. Editing before reading, changing code without running it,
   * and a tool that failed are the three findings that transfer.
   */
  coachTheProcess: Schema.Boolean,
  /** Running a model heavier or lighter than the answer turned out to need. See {@link ModelTier}. */
  coachTheModelChoice: Schema.Boolean,
  /**
   * THE INSTRUCTOR'S VOICE OVER THE TOP OF THE SWITCHES, exactly as `Assistant.instructions` sits
   * over `guardrails`.
   *
   * ⚠ IT STEERS HOW A NUDGE IS WORDED AND NEVER WHETHER ONE FIRES. The switches above and the
   * derivations behind them decide that. Prose cannot add a branch, and a rubric whose switches are
   * all off says nothing however much is written here.
   */
  instructions: Schema.String,
}).annotate({ identifier: "Jolli.CoachingRubric" })

/**
 * THE RESTING RUBRIC: everything on, nothing written.
 *
 * ⚠ IT IS THE FALLBACK FOR AN UNRESOLVED ASSISTANT AS WELL AS THE SEED FOR A NEW ONE, and the
 * fallback is the half worth arguing. A session whose assistant is gone resolving to all-off would
 * make a deleted assistant silently delete its own nudges: a professor would watch a thread lose its
 * marks with nothing on any screen to explain it. Resolving to the standard rubric fails towards the
 * behaviour every reader already expects.
 *
 * ⚠ IT SITS WITH THE SHAPE RATHER THAN WITH EITHER USER, BECAUSE BOTH OF THEM ARE THE SAME ANSWER.
 * `packages/core` stamps it onto every assistant the gateway serves — which serves no rubric yet —
 * and `packages/app` falls back to it when a session's assistant cannot be resolved. Held as two
 * consts they had to be edited together, and the gateway's default silently disagreeing with the
 * renderer's fallback is a difference nothing would report.
 */
export const STANDARD_RUBRIC: CoachingRubric = {
  coachTheQuestion: true,
  coachTheProcess: true,
  coachTheModelChoice: true,
  instructions: "",
}

/**
 * A PROCEDURE A STUDENT CAN REACH FOR IN A SESSION, AND WHICH ASSISTANT OFFERS IT.
 *
 * ⚠ A SKILL IS INVOKED; A RUBRIC LANDS UNASKED. That is the whole difference between this and
 * {@link CoachingRubric}, and it is the distinction the web mock arrived at after building process
 * coaching as rubric switches first and calling that the wrong axis.
 *
 * ⚠ PROCESS COACHING THEREFORE EXISTS TWICE ON THIS SURFACE, ON PURPOSE, AND IT IS THE ONE THING TO
 * KNOW BEFORE READING EITHER. `CoachingRubric.coachTheProcess` reads a turn's tool calls and writes
 * a nudge nobody asked for; the `process-coaching` SKILL is a procedure a student invokes. The web
 * mock treats these as one concept and keeps only the skill. This port keeps both:
 *
 *   - they fire at different moments — one after every reply, one when asked;
 *   - they are read by different code — `coaching.ts` never looks at this array, and a skill is
 *     prose handed to the model, so neither can change what the other says;
 *   - and a professor can switch the rubric key off and still offer the skill, or the reverse.
 *
 * ⚠ WHAT THAT COSTS IS A READER'S TIME, AND IT IS THE THING TO FIX FIRST IF IT GETS CONFUSING. Two
 * controls named for one idea means "why did I get a process note?" has two possible answers. If a
 * later round consolidates, the web mock's own conclusion is that the SKILL is the half to keep.
 */
export interface AssistantSkill extends Schema.Schema.Type<typeof AssistantSkill> {}
export const AssistantSkill = Schema.Struct({
  /**
   * A STABLE HANDLE FOR THIS ROW, NOT DERIVED FROM THE NAME. The name is the professor's to edit, so
   * a slug would change under a rename and take any join with it. It is a React key and a handle
   * for the gateway — see `slash-groups.ts`, which is the only reader.
   */
  skillId: Schema.String,
  /**
   * WHAT IT IS CALLED, IN THE PROFESSOR'S WORDS. Title Case: it names a procedure.
   *
   * ⚠ THE ONE FIELD HERE A STUDENT READS, which is why it is separate from `instructions` rather
   * than its first line. A student reaches for a skill BY NAME, so this is a label on a control.
   */
  name: Schema.String,
  /**
   * The instructor's own words for this skill on this assistant. Never shown to a student — it is
   * the procedure the assistant follows, not a description of it.
   */
  instructions: Schema.String,
}).annotate({ identifier: "Jolli.AssistantSkill" })

/**
 * HOW HEAVY A MODEL IS, for the model-choice nudge.
 *
 * ⚠ IT COMES FROM THE GATEWAY NOW, NOT FROM A LOCAL TABLE. It used to be looked up in
 * `MODEL_CATALOG` by model id; once model ids became Registry UUIDs that lookup could never match.
 * `AgentModel.category` is the gateway's own answer — `Premium` and `Basic` — and a model it does
 * not classify produces no nudge at all, which is the behaviour the web mock settled on.
 */
export const ModelTier = Schema.Literals(["premium", "economy"]).annotate({ identifier: "Jolli.ModelTier" })
export type ModelTier = typeof ModelTier.Type

export interface Assistant extends Schema.Schema.Type<typeof Assistant> {}
export const Assistant = Schema.Struct({
  id: Schema.String,
  courseId: Schema.String,
  name: Schema.String,
  /**
   * ⚠ ONLY `code` ASSISTANTS REACH THIS APPLICATION — see {@link AssistantKind} and
   * `assistantsForCourse`, which drops the rest before any screen sees them.
   */
  kind: AssistantKind,
  /** One line, lower case. Shown as the row's hover text in the picker. */
  blurb: Schema.String,
  accent: Accent,
  /**
   * True for the one a student gets when they pick nobody, and at most one per course.
   *
   * ⚠ THE GATEWAY EXPRESSES THE DEFAULT BY ORDERING, not by this flag — see
   * {@link Course.assistantIds}. `api.ts` sets it from that order.
   */
  isDefault: Schema.Boolean.pipe(optional),
  /**
   * ⚠ ALWAYS EMPTY ON THIS SURFACE, WHICH REVERSES WHAT THIS FIELD WAS PORTED FOR. It arrived as
   * "the professor's prompt, carried so the picker can show what a student is choosing". Jolli Edu
   * serves students a separate shape precisely so a sentence written ABOUT a class cannot reach the
   * class, and the course prompt is injected server-side by the gateway. Nothing renders it today;
   * do not build a picker that does. Kept as a field because the type is shared with surfaces that
   * may legitimately have it.
   */
  instructions: Schema.String,
  /**
   * WHICH MODELS THIS ASSISTANT MAY RUN ON, AS A GRANT.
   *
   * ⚠ THESE ARE OPENCODE MODEL KEYS (`jolli/<uuid>`), NOT THE WEB MOCK'S BARE IDS. The education
   * mock names a model `claude-sonnet-5`; this application resolves one as a `{providerID, id}`
   * pair, so a bare id would match nothing. The GRANT ports faithfully — which assistants are
   * restricted and how tightly — while the ids are written in this surface's vocabulary. Already
   * stripped of anything the catalogue no longer carries.
   *
   * ⚠ EMPTY MEANS UNRESTRICTED, NOT "NO MODELS". A course that has not thought about model access
   * must behave exactly as the product did before this field existed. Note this is the opposite
   * empty-case to {@link skills}.
   */
  allowedModelIds: Schema.Array(Schema.String),
  /**
   * THE MODEL THIS ASSISTANT RUNS ON UNLESS THE STUDENT SAYS OTHERWISE — the professor's pick, in
   * the same prefixed form as {@link allowedModelIds}. Absent when the catalogue no longer carries
   * it.
   *
   * ⚠ IT SHOULD BE ONE OF {@link allowedModelIds}, AND NOTHING ENFORCES THAT. A default outside the
   * grant is filtered out downstream and the composer falls back to the first granted model, which
   * is a quiet, sensible failure rather than a broken screen.
   */
  modelId: Schema.String.pipe(optional),
  guardrails: AssistantGuardrails,
  /**
   * See {@link CoachingRubric}.
   *
   * ⚠ REQUIRED, NOT OPTIONAL. There is no course-level rubric for an absent value to be a live
   * reference TO, so absent would mean nothing but "the product's guess" — and this field decides
   * what a student is told about their own working. An optional field reads identically at every
   * call site, so it gets left off.
   */
  coaching: CoachingRubric,
  /**
   * THE PROCEDURES THIS ASSISTANT OFFERS. See {@link AssistantSkill}.
   *
   * ⚠ EMPTY MEANS EXACTLY NO SKILLS — the opposite of {@link allowedModelIds}, and a trap worth
   * saying out loud. A grant narrows a set that already exists; this one enumerates a set that does
   * not, and there is no "all skills" an assistant could sensibly be handed. The gateway has no
   * skills concept, so this is always empty today.
   *
   * ⚠ CARRIED AND DISPLAYED, NOT ENFORCED HERE. opencode discovers skills from the paths the
   * gateway declares and narrows them per agent; this surface shows a student what their assistant
   * offers. Same posture {@link AssistantGuardrails} takes, for the same reason.
   */
  skills: Schema.Array(AssistantSkill),
  /**
   * AN OVERRIDE, AND DELIBERATELY OPTIONAL RATHER THAN A COPY OF THE COURSE'S VALUE. An assistant
   * carrying its own copy would silently keep the old answer when the course changed its mind.
   * Absent means "whatever the course says" — see `sharing.ts`'s `effectiveSharing`, where the
   * strictest of course and assistant wins.
   *
   * ⚠ ALWAYS ABSENT TODAY: the gateway has no sharing field on either shape.
   */
  chatSharing: ChatSharing.pipe(optional),
  status: Schema.Literals(["draft", "live", "paused"]),
}).annotate({ identifier: "Jolli.Assistant" })

/**
 * WHETHER THE GATEWAY ACTUALLY ANSWERED.
 *
 * ⚠ "NO COURSES" AND "COULD NOT ASK" ARE DIFFERENT ANSWERS AND MUST STAY THAT WAY. Both arrive as
 * an empty `courses` array, and a client that cannot tell them apart tells a student on a dropped
 * connection that none of their courses use this product — sending them to their registrar over a
 * Wi-Fi problem. `checkCourseGate` in the desktop main process has always drawn this line because
 * it calls `loadCatalog` itself; this field is how the line reaches everyone reading the route.
 *
 * ⚠ NO CREDENTIAL IS `unreachable`, WHICH READS ODDLY UNTIL YOU ASK WHAT ELSE IT COULD BE. Signed
 * out we never asked, so "you have no courses" would be an assertion we have no basis for. Clients
 * that care about the difference already know whether they hold a credential and check that first.
 */
export const CatalogStatus = Schema.Literals(["ok", "unreachable"]).annotate({
  identifier: "Jolli.CatalogStatus",
})
export type CatalogStatus = typeof CatalogStatus.Type

/** What `/jolli/course` answers with. */
export interface Catalog extends Schema.Schema.Type<typeof Catalog> {}
export const Catalog = Schema.Struct({
  /** See {@link CatalogStatus}. An empty catalogue means nothing until you have read this. */
  status: CatalogStatus,
  courses: Schema.Array(Course),
  assistants: Schema.Array(Assistant),
  /**
   * Every granted model's weight, keyed by opencode model key (`jolli/<uuid>`).
   *
   * ⚠ IT IS A MAP RATHER THAN A FIELD ON THE ASSISTANT, AND THAT DISTINCTION IS THE WHOLE POINT.
   * The coaching nudge asks about the model that ACTUALLY RAN a turn, which the student may have
   * switched away from the professor's default. An assistant-level tier would answer a different
   * question and be quietly wrong every time somebody used the picker.
   *
   * ⚠ A MODEL THE GATEWAY DID NOT CLASSIFY IS SIMPLY ABSENT, which is how "say nothing about a
   * model nobody classified" stays the default.
   */
  modelTiers: Schema.Record(Schema.String, ModelTier),
}).annotate({ identifier: "Jolli.Catalog" })
