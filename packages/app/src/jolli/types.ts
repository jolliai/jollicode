/**
 * THE DOMAIN CONTRACT FOR THE EDUCATION SURFACE, AS THE DESKTOP READS IT.
 *
 * These shapes are ported from the professor-facing mock (jolli-edu-design,
 * `app/src/data/types.ts`) rather than invented here, because a professor configures a course on
 * that surface and a student meets the result on this one. Two definitions of Course would be two
 * products.
 *
 * ⚠ THIS IS A TRIM, NOT A COPY. The web product's shapes carry fields no desktop screen reads:
 * rosters, materials, passcodes, term dates, billing. They are omitted rather than stubbed, so a
 * reader of this file cannot mistake an unused field for one this surface honours. Anything the
 * desktop starts reading gets added back deliberately.
 *
 * ⚠ AND IT IS A MOCK'S DATA SOURCE. In the real product these arrive from the Jolli gateway as
 * course-scoped config (see jolli/PLAN.md); here they are fixtures. Nothing else about the shapes
 * changes when that swap happens, which is the point of porting them faithfully.
 */

/**
 * WHO MAY READ A STUDENT'S SESSION. Ported verbatim, including the third value.
 *
 * ⚠ `staff-required` IS NOT A STRICTER `staff`, IT IS A LOCK, and the distinction is the whole
 * reason the union has three members instead of a boolean plus a flag. Under `staff` a student may
 * make one session private; under `staff-required` that control is refused and says who refused it.
 */
export type ChatSharing = "private" | "staff" | "staff-required"

/**
 * WHAT A COURSE MAY HAND ITS STUDENTS. A `code` course hands them this application.
 *
 * ⚠ THE KIND IS NOT A SUBJECT AND MUST NEVER BE DERIVED FROM ONE. "CS" in a course code names a
 * department, and a computer science department runs theory courses that never open an editor. The
 * professor picks this. (DESIGN-GUIDE.md §3c.)
 */
export type CourseKind = "standard" | "code"

/**
 * WHAT AN ASSISTANT IS FOR, WHICH DECIDES WHETHER IT BELONGS IN THIS APPLICATION AT ALL.
 *
 * ⚠ THIS FIELD LEADS THE WEB MOCK RATHER THAN PORTING FROM IT. `jolli-edu-design` has no assistant
 * kind yet — a professor there builds one assistant and it answers anywhere. The desktop is the
 * surface that makes the distinction necessary: an assistant written to answer "when is this due"
 * has no business being offered inside an editor, and a student who picks it gets a session that
 * cannot do the thing they opened the app to do. The web side gains the same field later; until it
 * does, this is the one shape on this surface that is ahead of that one.
 */
export type AssistantKind = "standard" | "code"

/**
 * A SESSION'S ACTUAL READERS, WHICH IS NOT THE SAME TYPE AS A COURSE'S POLICY.
 *
 * ⚠ TWO INDEPENDENT FACTS, NOT ONE ENUM, AND THE WEB MOCK IS SHAPED THE SAME WAY: a conversation
 * there carries `staffShared` (a boolean) alongside `shares` (a list that may include the
 * course-wide sentinel). A student can hand a session to their professor, to their classmates, to
 * both, or to nobody, and collapsing that into one ordered value would make "shared with the class
 * but not with staff" unrepresentable — which is the state a study group actually wants.
 *
 * ⚠ `ChatSharing` DECIDES WHERE THIS STARTS AND NOTHING MORE. A policy governs what a NEW session
 * begins as; from then on visibility is a fact about the session. See `defaultSessionSharing`.
 */
export interface SessionSharing {
  /** Course staff can read it. Starts from the course policy, then it is the student's to toggle. */
  staff: boolean
  /**
   * Everyone enrolled in the course can read it. The web mock's `EVERYONE` sentinel: a MEMBERSHIP,
   * not a link, so it never includes anybody outside the course and it follows the roster.
   */
  everyone: boolean
}

/**
 * THE COURSE'S PLACE ON THE DATAVIZ RAMP. Identity, not status: it is true of the course on its
 * best day, which is why a kind chip is tinted with it and a lifecycle chip is not.
 */
export type Accent = 1 | 2 | 3 | 4 | 5

export interface Course {
  id: string
  /** What a student calls it out loud. "CS 310". */
  code: string
  title: string
  kind: CourseKind
  description?: string
  accent: Accent
  /**
   * ⚠ ORDER IS MEANINGFUL: the course's own preferred order, with the default assistant first.
   * A course may legitimately have none — `cs-101` is a draft nobody has configured yet, and that
   * empty branch is the one worth reviewing.
   */
  assistantIds: string[]
  status: "draft" | "published" | "archived"
  /** The default a NEW session starts at. A session's own visibility is a fact about the session. */
  chatSharing: ChatSharing
}

/**
 * WHAT AN ASSISTANT MAY NOT DO, WHICH IS THE CONTRACT A PROFESSOR ACTUALLY SETS.
 *
 * ⚠ CARRIED BUT NOT YET ENFORCED ON THIS SURFACE. The gateway enforces these; the desktop shows
 * them so a student knows the terms of the assistant they picked. Storing them without acting on
 * them is deliberate and is the honest state of a mock — do not add a code path that pretends to
 * enforce one locally.
 */
export interface AssistantGuardrails {
  neverGiveDirectAnswers: boolean
  restrictToMaterials: boolean
  showCitations: boolean
  /** Zero means uncapped. */
  weeklyTokenCap: number
}

/**
 * WHAT A COACHING NUDGE BESIDE THIS ASSISTANT'S ANSWERS MAY BE ABOUT.
 *
 * ⚠ THE PROFESSOR SETS THIS IN THE WEB PRODUCT AND THIS SURFACE ONLY APPLIES IT. There is no
 * builder here and there should not be one: a rubric arrives on the assistant exactly as
 * `guardrails` and `allowedModelIds` do, and `fixtures.ts` stands in for the gateway. A control
 * that edited one would be this application inventing a professor.
 *
 * ⚠ THE SWITCHES DECIDE WHICH DERIVATIONS MAY RUN, NEVER WHAT A NUDGE SAYS. The web mock
 * (`app/src/components/chat/coach.ts`) spends its header on why, and it is worth repeating here
 * because this port adds a model to the loop: its own deleted retrospective recorded four of its
 * five first-draft cards reading well and being false. A rubric selects; it does not write.
 *
 * ⚠ ALL THREE REST ON, WHICH IS THE OPPOSITE OF `AssistantGuardrails` AND DELIBERATE. A guardrail
 * RESTRICTS the assistant, so off is its permissive resting state and defaulting them all on would
 * teach the reader wrong. A coaching switch is what the coach may HELP with, so off is the
 * restrictive direction and all-on is the generous one.
 *
 * ⚠ ALL THREE OFF IS A REAL CONFIGURATION AND NOT A NULL STATE: this assistant is not coached, and
 * what renders is nothing at all rather than a nudge nobody wrote.
 */
/**
 * A PROCEDURE A STUDENT CAN REACH FOR IN A SESSION, AND WHICH ASSISTANT OFFERS IT.
 *
 * ⚠ THE PROFESSOR WRITES THE ROW. Name and instructions, authored in the web product, arriving here
 * exactly as `guardrails` and `coaching` do. There is no builder on this surface.
 *
 * ⚠ A SKILL IS INVOKED; A RUBRIC LANDS UNASKED. That is the whole difference between this and
 * `CoachingRubric`, and it is the distinction the web mock arrived at after building process
 * coaching as rubric switches first and calling that the wrong axis.
 *
 * ⚠ PROCESS COACHING EXISTS TWICE ON THIS SURFACE, ON PURPOSE, AND IT IS THE ONE THING TO KNOW
 * BEFORE READING EITHER. `CoachingRubric.coachTheProcess` reads `Turn.tools` and writes a nudge
 * nobody asked for; the `process-coaching` SKILL is a procedure a student invokes. The web mock
 * treats these as one concept and keeps only the skill, having built the rubric version first and
 * called it the wrong axis. This port keeps both, which is a deliberate divergence rather than an
 * oversight:
 *
 *   - they fire at different moments — one after every reply, one when asked;
 *   - they are read by different code — `coaching.ts` never looks at this array, and the skill is
 *     prose handed to the model, so neither can change what the other says;
 *   - and a professor can switch the rubric key off and still offer the skill, or the reverse.
 *
 * ⚠ WHAT THAT COSTS IS A READER'S TIME, AND IT IS THE THING TO FIX FIRST IF THIS GETS CONFUSING. Two
 * controls named for one idea means "why did I get a process note?" has two possible answers. If a
 * later round consolidates, the web mock's own conclusion is that the SKILL is the half to keep.
 *
 * ⚠ AND A NAME PLUS INSTRUCTIONS IS THE WHOLE OF IT, with no switches under it. What a skill does is
 * prose, the way a skill is prose everywhere else in this product family.
 */
export interface AssistantSkill {
  /**
   * A STABLE HANDLE FOR THIS ROW, NOT DERIVED FROM THE NAME. The name is the professor's to edit, so
   * a slug would change under a rename and take any join with it. Nothing on this surface joins
   * against a specific id today — see the divergence note above — so an id here is a React key and a
   * handle for the gateway, which is exactly what it is in the web mock for a professor's own skill.
   */
  skillId: string
  /**
   * WHAT IT IS CALLED, IN THE PROFESSOR'S WORDS. Title Case: it names a procedure.
   *
   * ⚠ THE ONE FIELD ON THIS INTERFACE A STUDENT READS, which is why it is separate from
   * `instructions` rather than its first line. A student reaches for a skill BY NAME, so this is a
   * label on a control and has to read like one.
   */
  name: string
  /**
   * The instructor's own words for this skill on this assistant. Never shown to a student — it is
   * the procedure the assistant follows, not a description of it.
   */
  instructions: string
}

export interface CoachingRubric {
  /** Thin prompts, and asking for the answer outright when the assistant may never give one. */
  coachTheQuestion: boolean
  /**
   * HOW THE WORK WAS DONE, READ OFF TOOL CALLS.
   *
   * ⚠ THIS IS THE WEB MOCK'S `pointAtTheMaterials` REPLACED RATHER THAN RENAMED, AND THE SWAP IS
   * THE WHOLE REASON THIS PORT IS NOT A COPY. There, the third axis is "you named a document and
   * did not attach it" — an essay-shaped failure, against a library of course materials. Here a
   * student is in a repository: the equivalent evidence is `Turn.tools`, which the web mock reads
   * only behind its `process-coaching` skill. Editing before reading, changing code without
   * running it, and a tool that failed are the three findings that transfer.
   */
  coachTheProcess: boolean
  /** Running a model heavier or lighter than the answer turned out to need. */
  coachTheModelChoice: boolean
  /**
   * THE INSTRUCTOR'S VOICE OVER THE TOP OF THE SWITCHES, exactly as `Assistant.instructions` sits
   * over `guardrails`.
   *
   * ⚠ IT STEERS HOW A NUDGE IS WORDED AND NEVER WHETHER ONE FIRES. The switches above and the
   * derivations behind them decide that. Prose cannot add a branch, and a rubric whose switches are
   * all off says nothing however much is written here.
   */
  instructions: string
}

export interface Assistant {
  id: string
  courseId: string
  name: string
  /**
   * ⚠ ONLY `code` ASSISTANTS REACH THIS APPLICATION — see `AssistantKind` and
   * `assistantsForCourse`, which drops the rest before any screen sees them.
   */
  kind: AssistantKind
  /** One line, lower case. Shown as the row's hover text in the picker. */
  blurb: string
  accent: Accent
  /** True for the one a student gets when they pick nobody. At most one per course. */
  isDefault?: boolean
  /**
   * The professor's prompt. Carried here so the picker can show what a student is choosing;
   * the gateway is what actually runs it.
   */
  instructions: string
  /**
   * WHICH MODELS THIS ASSISTANT MAY RUN ON, AS A GRANT.
   *
   * ⚠ THESE ARE OPENCODE MODEL KEYS (`providerID/modelID`), NOT THE WEB MOCK'S BARE IDS. The
   * education mock names models as `claude-sonnet-5`; this application resolves a model as a
   * `{providerID, id}` pair off models.dev, so a bare id would match nothing. The GRANT is ported
   * faithfully — which assistants are restricted and how tightly — while the ids are written in
   * this surface's vocabulary.
   *
   * An empty array means no restriction, which is how a course that has not thought about it
   * behaves.
   */
  allowedModelIds: string[]
  /**
   * THE MODEL THIS ASSISTANT RUNS ON UNLESS THE STUDENT SAYS OTHERWISE. The professor's pick, and
   * the web mock's `Assistant.modelId` (jolli-edu-design) — there it is what every chat starts on.
   *
   * ⚠ PREFIXED HERE, BARE THERE. The web mock names a model `claude-opus-4-8`; this application
   * resolves one as `providerID/modelID`, and the same prefix `allowedModelIds` carries.
   *
   * ⚠ IT SHOULD BE ONE OF `allowedModelIds`, AND NOTHING ENFORCES THAT. A default outside the grant
   * is filtered out downstream and the composer falls back to the first granted model, which is a
   * quiet, sensible failure rather than a broken screen.
   */
  modelId?: string
  guardrails: AssistantGuardrails
  /**
   * WHAT A COACHING NUDGE BESIDE THIS ASSISTANT'S ANSWERS MAY BE ABOUT. See `CoachingRubric`.
   *
   * ⚠ REQUIRED, NOT OPTIONAL, AND FOR THE SAME REASON THE WEB MOCK MAKES IT REQUIRED. There is no
   * course-level rubric for an absent value to be a live reference TO, so absent would mean nothing
   * but "the product's guess" — and this field decides what a student is told about their own
   * working. An optional field reads identically at every call site, so it gets left off.
   */
  coaching: CoachingRubric
  /**
   * THE PROCEDURES THIS ASSISTANT OFFERS. See `AssistantSkill`.
   *
   * ⚠ REQUIRED AND OFTEN EMPTY, WHICH IS THE OPPOSITE OF `allowedModelIds` AND HAS TO BE SAID OUT
   * LOUD. An empty model grant means NO restriction — the whole catalogue. An empty skill list means
   * NO skills, exactly. Two array fields on one interface with opposite empty-cases is a trap, and
   * the reason they differ is that a grant narrows a set that already exists while this one
   * enumerates a set that does not: there is no "all skills" an assistant could sensibly be handed.
   *
   * ⚠ CARRIED AND DISPLAYED, NOT ENFORCED HERE. opencode discovers skills from the paths the gateway
   * declares and narrows them per agent; this surface shows a student what their assistant offers.
   * Same posture `AssistantGuardrails` takes, for the same reason — do not add a code path that
   * pretends to enforce one locally.
   */
  skills: AssistantSkill[]
  /**
   * ⚠ AN OVERRIDE, AND DELIBERATELY OPTIONAL RATHER THAN A COPY OF THE COURSE'S VALUE. An assistant
   * that carried its own copy would silently keep the old answer when the course changed its mind.
   * Absent means "whatever the course says". See `effectiveSharing`.
   */
  chatSharing?: ChatSharing
  status: "draft" | "live" | "paused"
}
