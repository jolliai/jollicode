/**
 * THE WORLD THIS MOCK RENDERS. Ported from the professor-facing mock (jolli-edu-design,
 * `app/src/data/courses.ts` and `app/src/data/assistants.ts`).
 *
 * ⚠ THE SAME TWO COURSES AS THE WEB SURFACE, ON PURPOSE. A customer shown both halves of this
 * product should meet one CS 310, not two that happen to share a code. Where a field exists on both
 * surfaces its value is copied rather than re-invented.
 *
 * ⚠ IN THE REAL PRODUCT THIS FILE DOES NOT EXIST. Courses and assistants arrive from the Jolli
 * gateway as course-scoped config, keyed to the signed-in student's enrolments (jolli/PLAN.md).
 * This module is the seam: replace its two exported arrays with a fetch and nothing above it
 * changes.
 */

import type { Assistant, Course } from "./types"

/**
 * ⚠ ONE PROVIDER, AND IT IS OURS. A grant names `jolli/<model id>` because the only provider this
 * application connects is the Jolli gateway, declared in
 * `packages/desktop/src/main/jolli-gateway.ts` and handed to the server as its own config. The
 * model ids are the web mock's, unchanged (jolli-edu-design, `app/src/data/models.ts`), so a grant
 * a professor sets on that surface means the same thing here.
 *
 * ⚠ IDS ARE COUPLED TO THAT FILE AND NOTHING CHECKS IT. A grant naming a model the gateway does not
 * declare is silently unreachable — the whitelist matches nothing, so the picker empties. If a
 * model disappears from a course, look there first.
 */
const JOLLI = (id: string) => `jolli/${id}`

/**
 * ⚠ AN EMPTY GRANT MEANS UNRESTRICTED, NOT "NO MODELS". A course that has not thought about model
 * access should behave like the product did before the field existed, and a professor who wants to
 * restrict does so by naming models rather than by remembering to fill something in.
 */
export const UNRESTRICTED: string[] = []

export const COURSES: Course[] = [
  {
    id: "cs-310",
    code: "CS 310",
    title: "Software Engineering",
    kind: "code",
    description:
      "A team-scale course: you will read a codebase you did not write, change it without breaking it, and " +
      "defend the change in review. Work happens in Jolli Code against a real repository, and the assistants " +
      "here read the same code you do.",
    accent: 3,
    // ⚠ THE CODING ASSISTANT LEADS, AND IT IS THE COURSE DEFAULT. On a code course the student is in
    // the editor, so the assistant they get when they pick nobody should be able to talk about the
    // code in front of them.
    assistantIds: ["cs-310-code", "cs-310-reviewer", "cs-310-desk"],
    status: "published",
    chatSharing: "staff",
  },
  {
    /**
     * ⚠ THE DAY-ONE DRAFT, AND IT IS HERE TO BE EMPTY. Nobody is enrolled and no assistant is
     * configured, which is the state every empty branch on this surface gets reviewed against: an
     * assistant picker with nothing to pick, a new session that cannot start. Deleting it would
     * leave those paths unphotographed.
     *
     * ⚠ IT DOES NOT RENDER WHILE IT IS A DRAFT. `enrolledCourses` is published-only, so this row
     * appears nowhere in the app as written; flip `status` to `"published"` to walk the empty
     * branches. That is the trade — a demo never shows a half-written course, and the empty states
     * cost one field to reach.
     *
     * ⚠ IT IS `code` AND HAS NO CODING ASSISTANT, DELIBERATELY. "Every code course should have one"
     * is a thing a professor does, not a thing a fixture asserts on her behalf.
     */
    id: "cs-101",
    code: "CS 101",
    title: "Computational Thinking",
    kind: "code",
    description:
      "An introduction to problem solving with code: decomposition, abstraction, and reading a program " +
      "before writing one. No prior experience assumed.",
    accent: 4,
    assistantIds: [],
    status: "draft",
    chatSharing: "private",
  },
]

export const ASSISTANTS: Assistant[] = [
  {
    id: "cs-310-code",
    courseId: "cs-310",
    name: "Jolli Code Assistant",
    kind: "code",
    blurb: "pairing in the editor: the codebase, the errors, and the test you are about to write",
    accent: 2,
    isDefault: true,
    instructions:
      "The assistant a student works with inside Jolli Code. Read the code they are looking at before " +
      "answering. When they bring you an error, explain what the message actually says and ask what they " +
      "expected to happen before suggesting a change. Prefer showing them how to find the answer in the " +
      "codebase to producing a diff: this course is graded on the student being able to do it again.",
    /**
     * ⚠ MORE THAN ONE MODEL IS WHAT MAKES THE PICKER EXIST AT ALL. The web mock's rule, ported: a
     * student sees a model control exactly when their professor allowed more than one
     * (`RecipientComposer.tsx` — "fewer than two allowed is not a choice, so it renders nothing
     * rather than a control with one option"). This is the assistant a student meets by default, so
     * it is also the one that shows the choice a course chose to give them.
     *
     * ⚠ TEN OF THE THIRTY-FOUR, ACROSS ALL THREE VENDORS AND BOTH BANDS, BECAUSE THREE WAS NOT A
     * CATALOGUE. The first cut granted three and the picker read as the whole product's model list
     * rather than as one course's selection from it — a customer cannot see a professor CHOOSING
     * from a list they never saw the size of. This is what a real course allows: the current
     * mid-tier and fast models from each vendor, with the frontier ones held back for the assistant
     * that needs them.
     */
    allowedModelIds: [
      JOLLI("claude-opus-5"),
      JOLLI("claude-opus-4-8"),
      JOLLI("claude-sonnet-5"),
      JOLLI("claude-sonnet-4-6"),
      JOLLI("claude-haiku-4-5"),
      JOLLI("gpt-5-6-sol"),
      JOLLI("gpt-5.5"),
      JOLLI("gpt-5.4"),
      JOLLI("gpt-5-6-luna"),
      JOLLI("gemini-3-1-pro"),
      JOLLI("gemini-3-7-flash"),
      JOLLI("gemini-3-6-flash"),
      JOLLI("gemini-3-flash"),
      JOLLI("gemini-3-1-flash-lite"),
    ],
    /**
     * ⚠ THE PROFESSOR PICKS WHAT IT STARTS ON, AND IT IS NOT THE FIRST ROW OF THE LIST. Without this
     * the composer opened on whichever granted model sorted first, which is a fact about
     * alphabetical order rather than about the course. Opus 4.8 is the version this course pinned —
     * the frontier model it is willing to pay for, one release behind the newest, which is what a
     * department that has finished arguing about it actually runs.
     */
    modelId: JOLLI("claude-opus-4-8"),
    guardrails: {
      neverGiveDirectAnswers: false,
      restrictToMaterials: false,
      showCitations: true,
      weeklyTokenCap: 0,
    },
    /**
     * ⚠ EVERYTHING ON, AND THE PROSE IS AIMED AT FREQUENCY RATHER THAN AT TOPIC. This is the
     * assistant a student lives in, so it is the one whose nudges have to earn their place: the web
     * mock shipped a round where a note fired on 80 of 80 answers, and the lesson it wrote down is
     * that a filler note beside a real one teaches the reader the mark is decoration.
     */
    coaching: {
      coachTheQuestion: true,
      coachTheProcess: true,
      coachTheModelChoice: true,
      instructions:
        "Write at most one nudge on a reply, and only when there is something specific to say. Read how the " +
        "question was asked, how the work was done, and what it ran on. Say what to do differently next time " +
        "rather than what went wrong, and say nothing at all when the exchange went fine.",
    },
    /**
     * ⚠ THE COURSE'S CODE ASSISTANT IS WHERE PROCESS COACHING IS SERVED FROM, and it is the only
     * assistant it could be: the skill reads how the WORK was done, and this is the one that runs
     * tools. `cs-310-desk` answers questions about deadlines and produces nothing for it to read.
     *
     * ⚠ IT IS THE SHIPPED SKILL AND IT LEADS THE LIST, because the order here is the order a student
     * meets them and this is the one the product wrote rather than the professor. See
     * `AssistantSkill` on why it coexists with `coaching.coachTheProcess` rather than replacing it.
     */
    skills: [
      {
        skillId: "process-coaching",
        name: "Process Coaching",
        instructions:
          "Read how the work was done, never what the code says. Say something when a change was reviewed " +
          "and the suite behind it never ran, when a planning step went first and made the rest of it " +
          "easier, and when a tool came back an error — that last one is your instructor's to fix rather " +
          "than yours. One note at most, and nothing at all when the exchange was ordinary.",
      },
      {
        skillId: "read-the-error",
        name: "Read The Error",
        instructions:
          "Take the error from the top: which file, which line, what the message literally says, and only " +
          "then what it means. Ask what they expected that line to do before explaining what it did. Stop " +
          "at the first thing that is actually wrong rather than listing everything that could be.",
      },
      {
        skillId: "plan-the-change",
        name: "Plan The Change",
        instructions:
          "Before any edit, say what you are about to change and why, in one or two lines, and name the test " +
          "or command that will show whether it worked. If you cannot name one, say so — that is the finding.",
      },
    ],
    status: "live",
  },
  {
    /**
     * ⚠ ONE MODEL, PINNED, AND THE CONTROL DISAPPEARS WITH IT. A review has to be worth trusting, so
     * this professor did not leave the choice open — and the web mock's rule then says a student
     * sees no model control at all rather than one with a single option. Switching from the pairing
     * assistant to this one takes the picker off the screen, which is the claim about
     * instructor-set guardrails happening in front of the reader rather than in a settings pane.
     */
    id: "cs-310-reviewer",
    courseId: "cs-310",
    name: "Code Reviewer",
    kind: "code",
    blurb: "reads a diff the way the marker will, and says what it would send back",
    accent: 3,
    instructions:
      "Review the diff the student brings you against the course rubric: correctness, tests, naming, and " +
      "whether the change is scoped to one thing. Say what a reviewer would send back and why. Give the " +
      "severity of each point. Do not rewrite the code for them; a review that hands over the answer has " +
      "taught nothing about reviewing.",
    allowedModelIds: [JOLLI("claude-opus-4-8")],
    modelId: JOLLI("claude-opus-4-8"),
    guardrails: {
      neverGiveDirectAnswers: true,
      restrictToMaterials: false,
      showCitations: true,
      weeklyTokenCap: 0,
    },
    /**
     * ⚠ MODEL-CHOICE COACHING IS OFF, AND THE REASON IS THE COMMENT AT THE TOP OF THIS ASSISTANT.
     * One granted model means the picker is not on the student's screen at all, so a nudge about
     * running something heavier or lighter than the answer needed would be advice about a control
     * they cannot reach. A switch off for a stated reason is what this field is for; all three on
     * everywhere would make the rubric decoration.
     */
    coaching: {
      coachTheQuestion: true,
      coachTheProcess: true,
      coachTheModelChoice: false,
      instructions:
        "This assistant never hands over an answer, so when a student asks for one, say what to ask instead " +
        "rather than restating the refusal. Read how the review was asked for and what they had already run.",
    },
    /**
     * ⚠ ONE PROCEDURE, AND IT IS THE ASSISTANT'S WHOLE JOB WRITTEN OUT. A review assistant whose
     * only skill is reviewing is not redundant: the skill is the student ASKING for it, which is
     * what makes the output theirs to act on rather than something they were handed.
     */
    skills: [
      {
        skillId: "review-against-the-rubric",
        name: "Review Against The Rubric",
        instructions:
          "Go through the diff the way the marker will: correctness first, then tests, then naming, then " +
          "whether the change is scoped to one thing. Give each point a severity and the reason a reviewer " +
          "would give it. Never rewrite the code — say what you would send back.",
      },
    ],
    status: "live",
  },
  {
    id: "cs-310-desk",
    courseId: "cs-310",
    name: "CS 310 Assistant",
    kind: "standard",
    blurb: "the assignments, the deadlines, and what the build expects of you",
    accent: 5,
    instructions:
      "The course-side assistant for CS 310. Answer questions about the assignments, the deadlines, the " +
      "submission process and what the build and the test suite are expected to do. Questions about writing " +
      "the code itself belong to the Jolli Code assistant, so point a student there rather than answering " +
      "them here.",
    allowedModelIds: UNRESTRICTED,
    guardrails: {
      neverGiveDirectAnswers: false,
      restrictToMaterials: false,
      showCitations: true,
      weeklyTokenCap: 0,
    },
    /**
     * ⚠ A STANDARD ASSISTANT NEVER REACHES THIS SURFACE — `assistantsForCourse` drops it — so this
     * rubric is carried rather than read. It is still stated rather than defaulted, for the reason
     * `CoachingRubric` gives at the field: an optional one reads identically at every call site, so
     * it gets left off. Process coaching is off because this assistant runs no tools to read.
     */
    coaching: {
      coachTheQuestion: true,
      coachTheProcess: false,
      coachTheModelChoice: true,
      instructions: "",
    },
    /**
     * ⚠ EMPTY, AND IT IS A REAL CONFIGURATION RATHER THAN AN UNFINISHED ONE — see the field's own
     * comment on why an empty skill list means NO skills while an empty model grant means NO
     * restriction. This assistant answers questions about deadlines; there is no procedure to run.
     */
    skills: [],
    status: "live",
  },
]

export function courseById(id: string | undefined): Course | undefined {
  if (!id) return undefined
  return COURSES.find((c) => c.id === id)
}

export function assistantById(id: string | undefined): Assistant | undefined {
  if (!id) return undefined
  return ASSISTANTS.find((a) => a.id === id)
}

/**
 * THE COURSE'S ASSISTANTS THAT THIS APPLICATION MAY RUN, IN THE COURSE'S OWN ORDER.
 *
 * ⚠ DRIVEN BY `assistantIds` RATHER THAN BY FILTERING `ASSISTANTS`, because the order is the
 * professor's and a filter would silently re-order to fixture order. A paused or draft assistant is
 * dropped: a student cannot start a session with one.
 *
 * ⚠ AND NON-CODE ASSISTANTS ARE DROPPED HERE, ONCE, RATHER THAN IN THE PICKER. Every screen on this
 * surface asks this function — the picker, the default, `canStartSession`, the in-chat label — so a
 * filter in the picker alone would leave `defaultAssistantFor` free to hand a session the course's
 * help-desk assistant and the label free to name it. CS 310's `cs-310-desk` answers questions about
 * deadlines and submission; it is a real assistant a student uses, on the web, where the question
 * gets asked. Offering it in an editor is offering a session that cannot do the thing they opened
 * this application for.
 */
export function assistantsForCourse(courseId: string | undefined): Assistant[] {
  const course = courseById(courseId)
  if (!course) return []
  return course.assistantIds
    .map(assistantById)
    .filter((a): a is Assistant => !!a)
    .filter((a) => a.status === "live")
    .filter((a) => a.kind === "code")
}

/**
 * THE ASSISTANT A STUDENT GETS WHEN THEY PICK NOBODY. Falls back to the first live one, and to
 * nothing at all on a course that has none — which `cs-101` is, and which callers must handle.
 */
export function defaultAssistantFor(courseId: string | undefined): Assistant | undefined {
  const list = assistantsForCourse(courseId)
  return list.find((a) => a.isDefault) ?? list[0]
}

/**
 * THE COURSES THIS STUDENT MAY OPEN A SESSION IN.
 *
 * ⚠ PUBLISHED ONLY — A DRAFT COURSE IS NEVER SHOWN ON THIS SURFACE. An earlier cut listed drafts
 * and merely refused to start them, on the reasoning that a student is really enrolled and should
 * not be told their course does not exist. The opposite is true: a draft is a course its professor
 * is still writing, and a student who has not been told it exists yet cannot be confused by its
 * absence — only by its presence. `cs-101` is therefore invisible here, and stays in `COURSES`
 * because flipping its status is how the empty-course branches get reviewed.
 *
 * `canStartSession` remains a separate question: a course can be published and still have no
 * assistant this application can run.
 */
export function enrolledCourses(): Course[] {
  return COURSES.filter((c) => c.status === "published")
}

/** Whether a session can actually be started in this course today. */
export function canStartSession(courseId: string | undefined): boolean {
  const course = courseById(courseId)
  if (!course || course.status !== "published") return false
  return assistantsForCourse(courseId).length > 0
}
