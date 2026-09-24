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
 * are not unread fields; they have working consumers in `packages/app` (`coaching.ts`,
 * `slash-groups.ts`) and a gateway that does not produce them yet. Consumer built,
 * producer pending — not a stub.
 *
 * Ported from `packages/app/src/jolli/types.ts`, whose comments recorded the invariants below.
 */

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
 * THE COURSE'S PLACE ON THE DATAVIZ RAMP. Identity, not status: it is true of the course on its
 * best day, which is why a kind chip is tinted with it and a lifecycle chip is not.
 *
 * ⚠ DERIVED FROM THE GATEWAY'S NUMERIC ID, NOT FROM THE NAME. jolliedu carries an `accent` column
 * that nothing writes yet (always 0), and its own client derives the colour from the id — it
 * records that deriving from the NAME repainted a course's every mark the moment it was renamed.
 */
export const Accent = Schema.Literals([1, 2, 3, 4, 5]).annotate({ identifier: "Jolli.Accent" })
export type Accent = typeof Accent.Type

/**
 * THE GLYPH A PROFESSOR PICKED FOR AN ASSISTANT, AS A CLOSED SET.
 *
 * ⚠ THESE ARE jolliedu's NAMES, CHARACTER FOR CHARACTER — `CourseAssistantIcon` in `jolli-common`.
 * The gateway stores one of exactly these and validates on write, so anything else on the wire is a
 * row written before a name was retired. Kept closed here for the same reason it is closed there:
 * the client maps the name to a render, and a free string is a way of putting an arbitrary key into
 * that map.
 *
 * ⚠ THE SET IS SEMANTIC, NOT DECORATIVE. A gavel for an ethics review board, a flask for a lab
 * viva — nothing derivable from an assistant's NAME produces those, which is why the professor
 * chooses and this travels.
 */
export const AssistantIcon = Schema.Literals([
  "Sparkles",
  "Gavel",
  "FlaskConical",
  "Clock",
  "GitPullRequest",
  "Terminal",
  "MessageCircleQuestion",
  "Presentation",
  "UserCheck",
  "BookOpen",
  "Compass",
  "Lightbulb",
  "Microscope",
  "PenLine",
  "Scale",
  "Users",
]).annotate({ identifier: "Jolli.AssistantIcon" })
export type AssistantIcon = typeof AssistantIcon.Type

/** What an assistant wears until somebody picks something else. jolliedu's own default. */
export const DEFAULT_ASSISTANT_ICON: AssistantIcon = "Sparkles"

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
  /**
   * ⚠ IT TRAVELS BESIDE `accent` BECAUSE THE TWO ARE ONE MARK. The accent tints the glyph; a colour
   * with nothing to tint is a stripe, and a glyph with no colour is every assistant's glyph.
   * `api.ts` narrows the wire's string to this union and falls back rather than dropping the row.
   */
  icon: AssistantIcon,
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

/**
 * WHO THE HELD CREDENTIAL BELONGS TO, FOR LABELLING ONE ROW.
 *
 * ⚠ DECODED FROM THE TOKEN, NEVER VERIFIED, AND NEVER AUTHORITATIVE. See
 * `packages/core/src/jolli/identity.ts` for the full argument. Nothing may branch on this except
 * what words to draw: not what a student may start, not what they may read, not which models run.
 *
 * ⚠ BOTH FIELDS OPTIONAL, AND ABSENCE MEANS "WE COULD NOT TELL" RATHER THAN "SIGNED OUT". A token
 * whose payload we could not read, or which carries neither claim, produces no viewer at all —
 * which is a different state from having no credential, and the account row words them differently.
 *
 * ⚠ NO AVATAR URL, DELIBERATELY. An image source taken from an unverified payload would make the
 * renderer fetch an attacker-choosable origin; the row draws an initial instead.
 */
export const Viewer = Schema.Struct({
  name: Schema.String.pipe(optional),
  email: Schema.String.pipe(optional),
}).annotate({ identifier: "Jolli.Viewer" })
export type Viewer = typeof Viewer.Type

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
  /**
   * The signed-in student, when the token would say. See {@link Viewer}.
   *
   * ⚠ IT RIDES ON THE CATALOGUE RATHER THAN ON A ROUTE OF ITS OWN, AND THAT IS THE POINT. Identity
   * and enrolment then come from the same token in the same process, so the two can never describe
   * different students — which is exactly the window the desktop's sidecar restart exists to close.
   * A second route would need its own store, its own in-flight de-duping and its own reset, each of
   * which is a way for it to disagree with this one.
   *
   * ⚠ OPTIONAL, SO IT IS OMITTED RATHER THAN SENT AS NULL. `optional` drops `undefined` on encode,
   * which is what keeps the existing whole-body route assertions unchanged.
   */
  viewer: Viewer.pipe(optional),
  /**
   * WHICH ACCOUNT THIS CATALOGUE BELONGS TO, SO A CLIENT CAN FILE A LOCAL PREFERENCE UNDER IT.
   *
   * ⚠ IT IS NOT {@link Viewer}, AND THE SEPARATION IS THE WHOLE REASON IT EXISTS. That field is
   * decoded from an unverified payload and is documented as labelling only — nothing may branch on
   * it except what words to draw. Keying persisted state off `viewer.email` would quietly make a
   * display string load-bearing; this one is the store's own notion of who the credential belongs
   * to (the `sub` the backend issued, falling back to the address it reported), which is the same
   * value the credential row is keyed by.
   *
   * ⚠ AND IT IS NOT THE CATALOGUE CACHE KEY EITHER, THOUGH THAT ALSO TELLS TWO STUDENTS APART.
   * `cache_key` is minted per row and signing out DELETES the row, so the same student coming back
   * gets a new one — fine for a cache that only has to avoid serving A's courses to B, useless for
   * remembering anything across a sign-out. This survives one.
   *
   * ⚠ IT MAY NOT BECOME AN AUTHORISATION INPUT, for the reasons `jolli/identity.ts` sets out at
   * length. What a student may start comes from the gateway's course data and from nowhere else.
   *
   * ⚠ OPTIONAL, AND ABSENCE MEANS "WE CANNOT TELL ACCOUNTS APART" RATHER THAN "SIGNED OUT". A
   * credential whose backend reported neither a subject nor an address produces none, and a client
   * that files something under it has to decide what to do with a bucket two people might share.
   */
  account: Schema.String.pipe(optional),
}).annotate({ identifier: "Jolli.Catalog" })

/**
 * WHO A SESSION HAS BEEN SHOWN TO, AS JOLLI EDU RECORDS IT.
 *
 * ⚠ THERE IS NO COURSE POLICY AND NO STORED VISIBILITY. An earlier build carried both — a course
 * `chatSharing` default and a two-switch `{ staff, everyone }` in session metadata — and both were a
 * mock of a model Jolli Edu does not have. These shapes are Jolli Edu's per-session grants (`ConversationShareRow` in jolliedu `common/src/types/CourseChat.ts`),
 * read and written through the sidecar's `/jolli/session/:sessionID/share` routes. A session is
 * private because it holds no grants, and readable by somebody because it holds one — there is no
 * stored "visibility" value to keep in step.
 *
 * ⚠ THE SAME CONVERSATION ON BOTH SIDES, BY ID. Every model call carries the session's ID as
 * `x-jolli-conversation-id`, and the gateway opens a `coding_agent` conversation under that public
 * ID the first time it sees one. Until the first message has reached the gateway there is nothing
 * there to share, which is what {@link ShareStatus} `unsynced` says.
 */

/**
 * WHAT A GRANT LETS SOMEBODY DO.
 *
 * ⚠ `comment` IS IN THE TYPE AND NOTHING MAY WRITE IT YET — jolliedu's `WRITABLE_SHARE_ACCESSES`
 * holds `view` alone and refuses the other with `access_not_writable`. It is read so a grant made by
 * a newer client still decodes, and never offered.
 */
export const ShareAccess = Schema.Literals(["view", "comment"]).annotate({ identifier: "Jolli.ShareAccess" })
export type ShareAccess = typeof ShareAccess.Type

/**
 * THE ONE SUBJECT THAT IS NOT A PERSON: THE COURSE'S WHOLE CLASS.
 *
 * ⚠ A LITERAL RATHER THAN A RESERVED USER ID, for jolliedu's reason: a sentinel inside the id space
 * is a number every reader must remember is not a person, and the first one that forgets resolves it
 * against the user directory and quietly drops the grant.
 */
export const EVERYONE = "everyone"

/** Who a grant is addressed to: one person by their Jolli user id, or the course's class. */
export const ShareSubject = Schema.Union([Schema.Int, Schema.Literal(EVERYONE)]).annotate({
  identifier: "Jolli.ShareSubject",
})
export type ShareSubject = typeof ShareSubject.Type

/**
 * ONE GRANT, RESOLVED.
 *
 * ⚠ A UNION ON `kind`, NOT A ROW WITH A NULLABLE PERSON. Every consumer decides who may read a
 * session or says so on a screen, and a union makes each of them say what it does about the class.
 *
 * ⚠ THE CLASS ROW CARRIES NO NAME. "Everyone in CS 101" is a sentence about the course, worded in
 * the renderer's dictionary from {@link SessionShare.courseCode}.
 */
export const SessionReader = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("person"),
    userId: Schema.Int,
    name: Schema.String,
    /** What tells two people with the same name apart. Absent when there is nothing to add. */
    detail: Schema.String.pipe(optional),
    access: ShareAccess,
  }),
  Schema.Struct({
    kind: Schema.Literal("class"),
    /** How many students that is, for the row's second line. */
    classSize: Schema.Int,
    access: ShareAccess,
  }),
]).annotate({ identifier: "Jolli.SessionReader" })
export type SessionReader = typeof SessionReader.Type

/**
 * SOMEBODY IN THE COURSE A SESSION COULD BE SHOWN TO.
 *
 * ⚠ THE SIGNED-IN STUDENT IS NEVER ONE OF THESE, and neither is a member whose role the course
 * ladder does not recognise — an unrecognised role is a row to look at, not a classmate. Both are
 * dropped by the sidecar before this crosses to the renderer.
 */
export interface ShareMember extends Schema.Schema.Type<typeof ShareMember> {}
export const ShareMember = Schema.Struct({
  userId: Schema.Int,
  /** The name a screen draws. Falls back to the address, never to an id. */
  name: Schema.String,
  detail: Schema.String.pipe(optional),
  kind: Schema.Literals(["staff", "student"]),
}).annotate({ identifier: "Jolli.ShareMember" })

/**
 * WHETHER THE SHARE ROUTE GOT AN ANSWER, AND WHICH ONE.
 *
 * - `ok` — the gateway answered and the rest of the body is its answer.
 * - `unsynced` — the gateway has no conversation under this ID that belongs to this student. Almost
 *   always a session whose first message has not reached it yet.
 * - `unreachable` — we never got to ask: signed out, no tenant, or the gateway did not answer.
 * - `refused` — a write the gateway turned down on purpose; {@link SessionShare.refusal} says why.
 */
export const ShareStatus = Schema.Literals(["ok", "unsynced", "unreachable", "refused"]).annotate({
  identifier: "Jolli.ShareStatus",
})
export type ShareStatus = typeof ShareStatus.Type

/**
 * WHY A WRITE WAS REFUSED, AS A CODE THE RENDERER WORDS.
 *
 * ⚠ A CLOSED SET WITH A FALLBACK. jolliedu's four codes, plus `unknown` for a refusal this client
 * has not heard of — a screen must never print a code at a student.
 */
export const ShareRefusal = Schema.Literals([
  "access_not_writable",
  "subject_not_in_course",
  "subject_is_owner",
  "conversation_has_no_course",
  "unknown",
]).annotate({ identifier: "Jolli.ShareRefusal" })
export type ShareRefusal = typeof ShareRefusal.Type

/**
 * WHAT EVERY `/jolli/session/:sessionID/share` ROUTE ANSWERS WITH.
 *
 * ⚠ ONE SHAPE FOR THE READ AND BOTH WRITES, so the panel replaces its answer wholesale after every
 * write rather than splicing a row in — jolliedu's rule: the server composes who can read a session,
 * and a client-side patch would be a second answer that can disagree with it.
 *
 * ⚠ `members` IS FILLED ONLY BY THE READ. The roster does not change because a grant did, so the
 * writes do not pay for it again and answer it empty; the renderer keeps the read's.
 */
export interface SessionShare extends Schema.Schema.Type<typeof SessionShare> {}
export const SessionShare = Schema.Struct({
  status: ShareStatus,
  courseId: Schema.NullOr(Schema.Int),
  courseCode: Schema.NullOr(Schema.String),
  readers: Schema.Array(SessionReader),
  members: Schema.Array(ShareMember),
  /**
   * How many students the course seats, for the "All N students" action.
   *
   * ⚠ COUNTED OFF THE WHOLE ROSTER, not off `members`, which has the signed-in student taken out —
   * jolliedu's `classSizeOf` makes the same point about a class that shrinks each time you look.
   * Zero whenever `members` is empty for the reason above.
   */
  classSize: Schema.Int,
  /**
   * Whether `members` is the roster the gateway returned (`ok`) or nothing because it could not be
   * read (`unavailable`).
   *
   * ⚠ AN EMPTY ROSTER AND AN UNREADABLE ONE ARE DIFFERENT ANSWERS. The first means nobody else is in
   * the course; the second means we do not know. Reading both off an empty array once told a student
   * "everyone in this course can already read it" over a session nobody could read.
   */
  roster: Schema.Literals(["ok", "unavailable"]),
  refusal: ShareRefusal.pipe(optional),
}).annotate({ identifier: "Jolli.SessionShare" })

