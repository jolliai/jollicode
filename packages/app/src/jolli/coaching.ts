/**
 * COACHING: an occasional nudge beside one reply, read off that reply.
 *
 * ⚠ THIS IS A PORT OF THE WEB MOCK'S `app/src/components/chat/coach.ts` (jolli-edu-design) AND THE
 * SHAPE IS DELIBERATELY THE SAME: a small set of branches, each reading a count, a flag or an id,
 * producing at most one nudge PER RUBRIC KEY and usually none at all. Read that file's header before
 * changing this one — it carries the arguments, and two of them are why this file is built as it is:
 *
 * 1. **NOTHING HERE SAYS "THAT WAS FINE".** An earlier round of the web mock fired on 80 of its 80
 *    answers, because the model-fit branch ended in an unconditional else. Having nothing specific
 *    to say is a state, and its rendering is no nudge at all.
 * 2. **A NUDGE IS A STATEMENT, NOT A SCOLD.** "You did not say what you had tried" is a telling-off;
 *    "naming what you have already tried gets you the next step instead of the whole answer" is the
 *    same fact aimed at the next message.
 *
 * ⚠ AND THE OUTPUT OF THIS FILE NEVER CONTAINS THE STUDENT'S WORDS, WHICH IS THE CONSTRAINT THAT
 * MAKES THE WHOLE FEATURE SURVIVABLE. A trigger carries an id, a focus and a derived sentence built
 * from counts. `promptText` is READ here — the refusal branch needs a pattern — but nothing derived
 * from it is ever emitted. Course staff read nudges off sessions a student withheld
 * (`SessionSharing.staff`), so a nudge that quoted the chat back would turn this feature into a
 * channel that discloses a private session's contents. See `coaching-prose.ts` for the one place a
 * model is allowed near the body, and the condition it is allowed under.
 *
 * ⚠ THE PROFESSOR AUTHORS THE RUBRIC ON THE WEB AND THIS SURFACE ONLY APPLIES IT. There is no
 * builder here; `CoachingRubric` arrives on the assistant exactly as `guardrails` does.
 */
import { Jolli } from "@opencode-ai/schema/jolli"
import { modelTier } from "./model-tier"
import type { Assistant } from "./types"

/** Which switch a trigger answers to. The rubric key, so a reader can trace one to the other. */
export type CoachFocus = "coachTheQuestion" | "coachTheProcess" | "coachTheModelChoice"

/**
 * ONE NUDGE, BEFORE ANY MODEL HAS SEEN IT.
 *
 * ⚠ `text` IS ALREADY A FINISHED SENTENCE AND THAT IS NOT A PLACEHOLDER. It is what renders when the
 * session is private, when the model call fails, and when it is slow — which means the feature
 * degrades to the web mock's exact behaviour rather than to an empty box. `coaching-prose.ts` may
 * sharpen it; nothing may replace it with nothing.
 *
 * `id` is stable per branch and is the React key. It is also what a staff surface would group on.
 */
export interface CoachTrigger {
  id: string
  focus: CoachFocus
  text: string
}

/** What one turn looks like to this file. Counts and flags, plus the prompt for the one pattern. */
export interface CoachTurnInput {
  assistant: Assistant | undefined
  /** ⚠ READ, NEVER EMITTED. See this file's header. */
  promptText: string
  /** Files on the student's message. */
  promptFileCount: number
  answerWords: number
  /** Every tool the assistant ran on this turn, in order. */
  tools: { tool: string; status: string }[]
  /** The opencode model key (`providerID/modelID`) that ran. */
  modelId?: string
}

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length

/**
 * WHICH MODELS ARE HEAVY AND WHICH ARE LIGHT — READ OFF THE GATEWAY CATALOGUE, NOT GUESSED.
 *
 * ⚠ THE TIER IS THE GATEWAY'S OWN ANSWER (`./model-tier`), so the nudge can never disagree with the
 * catalogue about a model's weight. A `premium` model is heavy and an `economy` model is light; a
 * model the gateway did not classify has no tier and produces no model-choice nudge rather than a
 * default one — the behaviour the web mock settled on. This replaces a pair of hand-kept regexes
 * that had drifted from the catalogue twice (`flash` was catching five standard models; four
 * premium `*-pro` models were matching nothing).
 *
 * ⚠ AND IT IS LOOKED UP BY MODEL KEY, NOT READ OFF THE ASSISTANT, because the question is about the
 * model that RAN this turn — which the student may have switched away from the professor's
 * default.
 *
 * ⚠ AND NO NUDGE NAMES A PRICE, EVER. The web mock spends a paragraph on this and it is the branch
 * that would slip: "was the model right for the job" is a question about FIT. A per-message cost
 * comparison inside a conversation is the one place this product must not put a number.
 */

const toolNames = (tools: CoachTurnInput["tools"]) => tools.map((t) => t.tool.toLowerCase())
const ran = (tools: CoachTurnInput["tools"], re: RegExp) => toolNames(tools).some((n) => re.test(n))

const EDIT = /^(edit|write|patch|multiedit)$/
const READ = /^(read|grep|glob|list)$/
const RUN = /^(bash|shell|test|run)$/

/**
 * THE NUDGES FOR ONE ASSISTANT REPLY, USUALLY NONE AT ALL.
 *
 * ⚠ IT RETURNS AN ARRAY BECAUSE THE BADGE CARRIES A COUNT, and that is the web mock's shape rather
 * than a convenience. Each GROUP below contributes at most one nudge — the branches inside a group
 * are mutually exclusive — so a reply can carry up to three, one per rubric key. An earlier build
 * here returned the first and stopped, which made every badge read "1" and turned the digit into
 * furniture.
 *
 * ⚠ THE ORDER IS THE STUDENT'S OWN DISTANCE FROM THE NUDGE rather than the order the branches were
 * written in, and it is stable because the groups run in a fixed order — which is what lets the
 * flyout render a flat list with no headings and never reshuffle between two turns. The question
 * leads because it is the only one about words the student chose and the only one they can act on in
 * their very next message; model choice sits last because it is about the tool rather than the work.
 *
 * ⚠ AN EMPTY ARRAY IS THE COMMON CASE AND ITS RENDERING IS NO BADGE AT ALL. Nothing here says "that
 * was fine": the web mock shipped a round whose model branch ended in an unconditional else, marking
 * 80 of 80 answers, and what that teaches a reader is that the mark is decoration.
 *
 * ⚠ THE RUBRIC GATES A WHOLE GROUP AND NOT ITS FIRST BRANCH, which is a real bug avoided rather
 * than a style preference. Inside `coachTheQuestion` the two branches are mutually exclusive: a
 * message matching the refusal pattern never reaches the word count. Guarding only the `if` would
 * leave the `else if` reachable, so switching the focus off would silently turn "you asked for the
 * answer outright" into "your question ran to six words" on exactly the messages the first branch
 * exists for — one switch turning a nudge off and a different nudge on.
 */
export function coachTurn(input: CoachTurnInput): CoachTrigger[] {
  const { assistant, promptText, promptFileCount, answerWords, tools, modelId } = input
  /** A session whose assistant is gone keeps its nudges. See `Jolli.STANDARD_RUBRIC`. */
  const rubric = assistant?.coaching ?? Jolli.STANDARD_RUBRIC
  const lower = promptText.toLowerCase()
  const notes: CoachTrigger[] = []

  // ── HOW IT WAS ASKED ────────────────────────────────────────────────────────────────────────
  if (rubric.coachTheQuestion) {
    const asked = words(promptText)
    /**
     * ⚠ THE REFUSAL CASE COMES FIRST, BECAUSE IT IS THE ONE THE READER IS ALREADY WONDERING ABOUT.
     * An assistant with `neverGiveDirectAnswers` declining to hand over an answer is the product
     * working as the instructor configured it, and the student who just got refused does not know
     * that. This is the nudge that turns a refusal from a failure into a rule they can work with.
     */
    if (
      assistant?.guardrails.neverGiveDirectAnswers &&
      /\b(just tell me|the answer|give me|what is the answer|write it for me|do it for me)\b/.test(lower)
    ) {
      notes.push({
        id: "asked-for-the-answer",
        focus: "coachTheQuestion",
        text:
          "You asked for the answer outright, and your instructor set this assistant never to hand one over, " +
          "so no wording will get it. Asking it to check the step you are stuck on will.",
      })
    } else if (asked > 0 && asked < 10) {
      /**
       * ⚠ TEN WORDS IS AN ARGUMENT RATHER THAN A TUNING, and it is the only branch here whose
       * trigger is a threshold and not a fact — so it is the one to re-read after any fixture
       * growth. The web mock ran at thirteen and caught a quarter of every reply, which makes a
       * nudge a property of the product rather than an observation about a message. Under ten words
       * is a question with essentially no context in it, which stays true if the fixtures change.
       */
      notes.push({
        id: "short-question",
        focus: "coachTheQuestion",
        text:
          `Your question ran to ${asked} words. A short question gets a general answer, because there is ` +
          "nothing in it to be specific about, and naming what you have already tried is usually the fastest " +
          "thing you can add.",
      })
    }
  }

  // ── HOW THE WORK WAS DONE ───────────────────────────────────────────────────────────────────
  /**
   * ⚠ THIS GROUP IS THIS PORT'S OWN, AND IT REPLACES THE WEB MOCK'S `pointAtTheMaterials`. There the
   * third axis is "you named a document and did not attach it", which is an essay-shaped failure
   * against a library of course materials. A student here is in a repository, and the equivalent
   * evidence is the tools the assistant ran. The web mock reads those too, but only behind its
   * `process-coaching` skill; on this surface they are the ordinary case, so they are a rubric key.
   *
   * ⚠ A FAILED TOOL LEADS, because it is the only one of the three the student can see went wrong
   * and the only one where the next action is obvious.
   */
  if (rubric.coachTheProcess && tools.length > 0) {
    const failed = tools.find((t) => t.status === "error")
    const edited = ran(tools, EDIT)
    if (failed) {
      notes.push({
        id: "a-tool-failed",
        focus: "coachTheProcess",
        text:
          `The ${failed.tool} step failed and the reply carried on past it, so part of this answer rests on ` +
          "something that never ran. Saying what you expected that step to produce is what gets it fixed " +
          "rather than skipped.",
      })
    } else if (edited && !ran(tools, READ)) {
      notes.push({
        id: "edited-without-reading",
        focus: "coachTheProcess",
        text:
          "This turn changed a file without reading one first. An edit written from the question rather than " +
          "from the code is the one that conflicts with what is already there, and asking it to read the file " +
          "before changing it costs you one step.",
      })
    } else if (edited && !ran(tools, RUN)) {
      notes.push({
        id: "changed-code-without-running",
        focus: "coachTheProcess",
        text:
          "Code changed on this turn and nothing ran afterwards, so neither of you knows whether it works. " +
          "Asking for the test or the command that proves it is the habit that separates a change from a " +
          "guess.",
      })
    }
  }

  // ── WHAT IT RAN ON ──────────────────────────────────────────────────────────────────────────
  /**
   * ⚠ NO `else` HERE, WHICH IS THE ROUND THE WEB MOCK HAD TO UNDO. An unconditional "that model
   * suited this" is a filler note beside a real one, and what that teaches a reader is that the mark
   * is decoration. An unrecognised model falls out of both branches and says nothing.
   */
  if (rubric.coachTheModelChoice && modelId) {
    const tier = modelTier(modelId)
    if (tier === "premium" && answerWords > 0 && answerWords < 60 && !ran(tools, EDIT)) {
      notes.push({
        id: "premium-short-answer",
        focus: "coachTheModelChoice",
        text:
          "You ran the heaviest model you have and the answer came back in a few lines with no code changed. " +
          "Questions this size are what the fast models are for, and knowing which ones need the big model is " +
          "the whole reason there is a choice.",
      })
    } else if (tier === "economy" && (answerWords > 400 || promptFileCount > 0)) {
      notes.push({
        id: "economy-long-answer",
        focus: "coachTheModelChoice",
        text:
          "That was a long piece of work for the lightest model on the list. When an answer has to hold a " +
          "whole file in its head, the heavier model is the one that keeps the thread — this is the kind of " +
          "question worth spending it on.",
      })
    }
  }

  return notes
}
