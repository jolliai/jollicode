/**
 * THE ONE PLACE A MODEL IS ALLOWED NEAR A STUDENT'S WORDS, AND THE CONDITION IT IS ALLOWED UNDER.
 *
 * ⚠ READ `coaching.ts` FIRST. That file decides WHETHER a nudge fires and on what topic, reading
 * only counts, flags and ids, and it hands back a finished sentence. This file may sharpen that
 * sentence in the professor's voice. It may never cause one, suppress one, or change its topic:
 * the rubric's switches are the only thing that decides what a student is coached about, and a
 * model that could add a nudge would be a model setting the professor's policy.
 *
 * ⚠ AND IT MAY ONLY SEE THE EXCHANGE WHEN COURSE STAFF COULD ALREADY READ IT. This is the whole
 * privacy argument of the feature, and it is enforced in `coachProseRequest` rather than trusted to
 * callers:
 *
 *   - Course staff read NUDGES off every session, including ones a student withheld from them.
 *     That separation is deliberate — the session's Jolli grants decide who reads the SESSION, and
 *     a nudge is not the session.
 *   - It is survivable only because a nudge is metadata: how long the question was, which model
 *     ran, whether a tool failed. A professor reading a nudge off a withheld session learns how
 *     their student worked, never what they wrote.
 *   - So the moment a model reads the body and writes the sentence, that nudge can carry the body.
 *     On a withheld session it therefore does not run at all, and the derived sentence stands.
 *
 * A withheld session is not a degraded experience: it gets exactly the product the web mock ships.
 *
 * ⚠ THE WRITER IS AN INTERFACE BECAUSE THE GATEWAY IS THE ONE THAT WILL IMPLEMENT IT. Nothing here
 * decides which model writes a nudge or what it costs — that is the gateway's job, as it is for
 * every other model call this application makes.
 */
import type { CoachTrigger } from "./coaching"

/**
 * WHAT A WRITER IS GIVEN. `exchange` is absent whenever the session is withheld from staff, and its
 * absence is the enforcement rather than a hint — a writer cannot opt into seeing more.
 */
export interface CoachProseRequest {
  trigger: CoachTrigger
  /** The professor's own words from `CoachingRubric.instructions`. May be empty. */
  instructions: string
  /**
   * ⚠ PRESENT ONLY WHEN STAFF CAN ALREADY READ THE SESSION. See this file's header for why that is
   * the condition, and `coachProseRequest` for where it is applied.
   */
  exchange?: { prompt: string; reply: string }
}

/**
 * Returns the sentence to show, or `undefined` to keep the derived one.
 *
 * ⚠ IT RETURNS `undefined` RATHER THAN THROWING ON THE ORDINARY FAILURE, because "I have nothing
 * better to say than the derived sentence" is a normal outcome and not an error.
 */
export type CoachProseWriter = (request: CoachProseRequest) => Promise<string | undefined>

/**
 * BUILD THE REQUEST, APPLYING THE PRIVACY RULE.
 *
 * ⚠ THE ONLY CONSTRUCTOR, AND THAT IS THE POINT. `exchange` is attached here or not at all, so a
 * later caller cannot pass the body through by forgetting a check. If you add a second way to build
 * one of these, you have removed the rule.
 */
export function coachProseRequest(input: {
  trigger: CoachTrigger
  instructions: string
  /**
   * Whether course staff can read this session on Jolli — `staffCanRead` in `session-share.ts`,
   * which fails closed. Pass nothing else here: this flag IS the privacy rule.
   */
  staffCanRead: boolean
  prompt: string
  reply: string
}): CoachProseRequest {
  const base = { trigger: input.trigger, instructions: input.instructions }
  if (!input.staffCanRead) return base
  return { ...base, exchange: { prompt: input.prompt, reply: input.reply } }
}

/**
 * THE BRIEF A WRITER SENDS TO THE MODEL.
 *
 * ⚠ IT IS BUILT HERE RATHER THAN IN THE WRITER SO THE RULES TRAVEL WITH THE REQUEST. Every
 * constraint below is one this feature already enforces somewhere else, restated for the model:
 * one or two sentences is `CoachTrigger`'s shape, the topic being fixed is `coaching.ts`'s job, no
 * price is the product rule the web mock spends a paragraph on, and "say nothing rather than
 * something safe" is the round it had to undo.
 *
 * ⚠ AND IT NEVER ASKS FOR A VERDICT. The derived sentence is the floor: a writer's job is to make
 * it land for THIS exchange, not to judge whether the exchange was good.
 */
export function coachProseBrief(request: CoachProseRequest): string {
  const lines = [
    "You are writing one coaching nudge for a student inside a coding assistant.",
    "",
    "The nudge's topic has already been decided and you may not change it. Your job is to say the " +
      "same thing, more precisely, for this particular exchange.",
    "",
    `The nudge to rewrite: ${request.trigger.text}`,
  ]
  if (request.instructions.trim()) {
    lines.push("", `Their instructor's standing guidance for nudges: ${request.instructions.trim()}`)
  }
  if (request.exchange) {
    lines.push(
      "",
      "The exchange it is about:",
      `<student>${request.exchange.prompt}</student>`,
      `<assistant>${request.exchange.reply}</assistant>`,
    )
  }
  lines.push(
    "",
    "Rules:",
    "- One or two sentences. No heading, no list, no preamble, no sign-off.",
    "- Aim it at their next message, not at the one they sent. State the fact, do not tell them off.",
    "- Never mention what a model costs.",
    "- Never quote the student back to themselves.",
    "- If you cannot improve on the nudge above, reply with it unchanged.",
  )
  return lines.join("\n")
}

/**
 * THE SENTENCE TO RENDER.
 *
 * ⚠ IT NEVER REJECTS AND NEVER RESOLVES EMPTY. The derived sentence is the floor: a writer that
 * throws, times out, returns nothing or returns something implausible leaves the student with
 * exactly the nudge the web mock would have shown. A coaching feature whose failure mode is an
 * empty box beside an answer would teach a reader to distrust the mark itself.
 *
 * ⚠ THE LENGTH CEILING IS A GUARD AGAINST THE FAILURE THIS FEATURE IS MOST EXPOSED TO, not tidiness.
 * A nudge is read beside the evidence it describes; a model that returns three paragraphs has
 * stopped writing a nudge and started writing an answer, and the honest response to that is to keep
 * the sentence we derived.
 */
export async function coachProse(request: CoachProseRequest, writer?: CoachProseWriter): Promise<string> {
  if (!writer) return request.trigger.text
  try {
    const written = await writer(request)
    const text = written?.trim()
    if (!text) return request.trigger.text
    if (text.length > 400) return request.trigger.text
    return text
  } catch {
    return request.trigger.text
  }
}

/**
 * WHO WRITES THE SHARPENED SENTENCE, IF ANYBODY DOES.
 *
 * ⚠ A MODULE-LEVEL SLOT RATHER THAN A CONTEXT, for the reason `model-grant.ts` gives at length: a
 * fork's own plumbing should not reorder the application shell. It is not reactive because it is set
 * once at startup and never swapped mid-session.
 *
 * ⚠ AND NOTHING REGISTERS ONE YET, WHICH IS THE HONEST STATE OF THIS MOCK AND NOT AN OVERSIGHT.
 * `AssistantGuardrails` in `types.ts` records the same posture for the same reason: the Jolli
 * gateway is what will write a nudge, this application has no route that runs a model outside a
 * session, and a local code path that pretended otherwise would be the fork claiming a capability it
 * does not have. Until one is registered every student sees the derived sentence — which is exactly
 * the product the web mock ships, so the unwired state is a complete feature rather than a stub.
 *
 * ⚠ WHEN ONE IS WIRED IT MUST HONOUR `CoachProseRequest.exchange` BEING ABSENT. A writer that went
 * and fetched the transcript itself would walk straight through the privacy rule this file exists
 * to enforce.
 */
let registered: CoachProseWriter | undefined

export const CoachWriter = {
  get: () => registered,
  set(writer: CoachProseWriter | undefined) {
    registered = writer
  },
}
