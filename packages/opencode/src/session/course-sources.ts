/**
 * THE SECOND MODEL CALL THAT DECIDES WHICH OF A COURSE TURN'S SOURCES ITS ANSWER RESTS ON.
 *
 * Runs once a course turn is over, in the background, and only when the course shows citations: the
 * answer is already on screen, and a turn whose sources nobody will see is not worth a model call.
 * It reads the turn back through the session, hands the answer and the evidence the turn's tools —
 * and the tools of the subagents it delegated to — returned to the model under a brief of its own, and writes the sources it picked onto the answer's
 * text part, where both renderers read them. The judging rules — what counts as evidence, the brief,
 * the one corrected retry — are `JolliSources`', shared with nothing else here.
 *
 * ⚠ THE TURN'S OWN MODEL, BRIEFED ALONE. The selection sees none of the course prompt and no tools,
 * only the answer and the evidence as data, so what it judges cannot be steered by either.
 *
 * ⚠ NOTHING IS WRITTEN WHEN IT FAILS. A turn without picked sources shows no sources row, which is
 * the honest rendering of "nothing was found to support this"; the reason goes to the log.
 */
export * as CourseSources from "./course-sources"

import { JolliSources } from "@opencode-ai/core/jolli/sources"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { LLMEvent } from "@opencode-ai/llm"
import { Effect, Option, Stream } from "effect"
import type { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { LLM } from "./llm"
import { MessageV2 } from "./message-v2"
import { type MessageID, SessionID } from "./schema"
import { Session } from "./session"

/**
 * The selection's agent. Not registered, so nothing can pick it, configure it or hand it a tool; it
 * exists only to carry the brief as the whole system prompt.
 */
const SELECTOR: Agent.Info = {
  name: "sources",
  mode: "primary",
  native: true,
  hidden: true,
  options: {},
  temperature: 0,
  permission: [{ permission: "*", pattern: "*", action: "deny" }],
  prompt: JolliSources.SELECTION_SYSTEM_PROMPT,
}

export const attribute = Effect.fn("CourseSources.attribute")(function* (input: {
  readonly sessionID: SessionID
  readonly userMessageID: MessageID
  /**
   * Whether the course shows citations, as the student's catalogue states it.
   *
   * ⚠ ASKED ONLY ONCE THERE IS SOMETHING TO JUDGE. It waits on the credential and the catalogue, and
   * most turns of a conversation return no evidence at all; those are told apart from the turn
   * itself, which this has already read.
   */
  readonly citationsShown: Effect.Effect<boolean>
}) {
  const sessions = yield* Session.Service
  const provider = yield* Provider.Service
  const llm = yield* LLM.Service
  const turn = yield* answerOf(sessions, input)
  if (!turn) return
  const answerPart = turn.answerPart
  if (!answerPart) {
    yield* Effect.logInfo("jolli course answer sources", {
      "session.id": input.sessionID,
      skipped: "the turn wrote no answer",
    })
    return
  }
  /**
   * ⚠ ONE SELECTION PER ANSWER. `SessionPrompt` asks for this every time its loop exits, and today
   * the loop only ever exits past a new answer: a prompt writes a user message first, and the one
   * route that runs the loop without one (summarize) writes a compaction message first, whose
   * "answer" is the summary skipped above. Were the loop ever run again over a turn already answered,
   * it would ask the model again and could replace the sources the student is already looking at
   * with another pick, so an answer that carries them is left alone.
   */
  if (answerPart.metadata?.answerSources !== undefined) return

  const candidates = JolliSources.turnCandidates([...turn.parts, ...(yield* delegatedParts(sessions, turn.parts))])
  const answer = JolliSources.turnAnswer(turn.parts)
  if (candidates.length === 0 || !answer) {
    yield* Effect.logInfo("jolli course answer sources", {
      "session.id": input.sessionID,
      candidates: candidates.length,
      skipped: "nothing to judge",
    })
    return
  }
  if (!(yield* input.citationsShown)) return

  const model = yield* provider.getModel(turn.last.providerID, turn.last.modelID)
  const outcome = yield* JolliSources.select({
    answer,
    candidates,
    complete: (conversation) => round({ llm, sessionID: input.sessionID, user: turn.user, model, conversation }),
  }).pipe(
    Effect.map((result) => ({ ok: true as const, ...result })),
    Effect.catch((error) =>
      Effect.succeed({
        ok: false as const,
        problem: error instanceof JolliSources.SelectionError ? error.problems.join("; ") : String(error),
        attempts: error instanceof JolliSources.SelectionError ? error.attempts : undefined,
      }),
    ),
  )
  if (!outcome.ok) {
    yield* Effect.logWarning("jolli course answer sources failed", {
      "session.id": input.sessionID,
      candidates: candidates.length,
      attempts: outcome.attempts,
      problem: outcome.problem,
    })
    return
  }

  /**
   * ⚠ WRITTEN ONTO THE PART AS IT IS NOW, NOT AS IT WAS READ. The selection can take up to a minute,
   * and in that time the student may have reverted or deleted the turn. The part is read back first:
   * one that is gone is not written again, and one that changed keeps its change. Should the message
   * be removed between that read and the write, the write cannot leave a part behind it — the part
   * table's foreign key refuses it, inside the transaction that would have published the update, so
   * nothing is stored or sent and the failure ends in the caller's warning.
   */
  const current = yield* sessions.getPart({
    sessionID: input.sessionID,
    messageID: answerPart.messageID,
    partID: answerPart.id,
  })
  if (current?.type !== "text") {
    yield* Effect.logInfo("jolli course answer sources", {
      "session.id": input.sessionID,
      skipped: "the answer was removed while its sources were being picked",
    })
    return
  }
  if (current.metadata?.answerSources !== undefined) return
  yield* sessions.updatePart({
    ...current,
    metadata: { ...current.metadata, answerSources: outcome.sources },
  })
  yield* Effect.logInfo("jolli course answer sources", {
    "session.id": input.sessionID,
    candidates: candidates.length,
    attempts: outcome.attempts,
    selected:
      outcome.sources
        .map((source) => (source.kind === "material" ? `${source.materialId}:${source.title}` : source.url))
        .join(" | ") || "none",
  })
})

/**
 * A finished course turn, read back for what is written beside its answer — its sources here, its
 * links in `CourseLinks`: the turn's parts, its closing step, and the text part the answer is in.
 * Undefined for a turn whose closing step is not an answer; `answerPart` is absent for one that wrote
 * no answer text.
 *
 * ⚠ THE TURN'S PARTS ARE READ ONCE, FOR EVERY USE: the answer that is judged, the evidence it is judged
 * against, and the part what sits beside it is written onto, so they cannot disagree on what the turn
 * was. A summary compaction wrote in the middle of the turn is none of them.
 *
 * ⚠ THE ANSWER IS THE TURN'S LAST TEXT, WHEREVER IT IS. A model can write its answer beside a tool
 * call and end on a step that writes nothing more, and a turn compaction cut in two can end that
 * way after the compaction too. The desktop timeline draws the sources under the steps the answer
 * sits among; the TUI draws them under the turn's final steps only, so an answer left before a
 * compaction shows its sources on the desktop alone.
 */
export const answerOf = Effect.fnUntraced(function* (
  sessions: Session.Interface,
  input: { readonly sessionID: SessionID; readonly userMessageID: MessageID },
) {
  const read = yield* readTurn(sessions, input)
  if (!read) return undefined
  const last = read.turn.findLast((item) => item.info.parentID === input.userMessageID)?.info
  // A summary a compaction wrote is not an answer, and nothing is listed under one.
  if (!last || last.error || last.summary) return undefined
  const parts = read.turn.flatMap((item) => (item.info.summary ? [] : item.parts))
  return {
    user: read.user,
    last,
    parts,
    answerPart: parts.findLast(
      (part): part is SessionV1.TextPart => part.type === "text" && JolliSources.isAnswerText(part),
    ),
  }
})

/**
 * The turn an answer closes, oldest first, read back from the newest message only as far as the
 * student message that opened it, or undefined when the answer's own user message is not there.
 *
 * ⚠ ONLY THE TURN, NOT THE SESSION. Reading every message of the session once per answered turn cost
 * more the longer the session ran; pages are read newest first and the reading stops at the turn's
 * opening message.
 *
 * ⚠ A TURN AUTO-COMPACTION CUT IN TWO IS READ WHOLE. Compaction carries on a turn under a user message
 * of its own — a compaction message, the summary answering it, then a synthetic "continue" message —
 * and the steps after it hang off that last one. Read from the answer's parent alone, the materials
 * read before the compaction, and what the model wrote about them, would never be judged. So the
 * reading goes back past those messages to the one the student wrote, and every step under any of
 * them belongs to the turn; the summary does not, and is left out by the caller.
 *
 * ⚠ A TURN AN OVERFLOW REPLAYED STARTS OVER, AND IS READ FROM THERE. When a step overflows the model's
 * context, compaction summarises only what came before the student's message and writes that message
 * again, unmarked, so the turn runs again from the copy. Nothing read before the compaction reaches
 * the model that answers, so it cannot be what the answer rests on: the reading stops at the copy.
 */
const readTurn = Effect.fnUntraced(function* (
  sessions: Session.Interface,
  input: { readonly sessionID: SessionID; readonly userMessageID: MessageID },
) {
  const newestFirst: SessionV1.WithParts[] = []
  const opening = yield* sessions
    .findMessage(input.sessionID, (message) => {
      newestFirst.push(message)
      // Only a message the student wrote can end the reading, so the search for the answer's own
      // message runs only on those, and they are few.
      return opensTurn(message) && newestFirst.some((seen) => seen.info.id === input.userMessageID)
    })
    .pipe(Effect.catch(() => Effect.succeed(Option.none<SessionV1.WithParts>())))
  const from = newestFirst.findIndex((message) => message.info.id === input.userMessageID)
  const user = newestFirst[from]?.info
  if (Option.isNone(opening) || user?.role !== "user") return undefined
  // From the answer's own user message back to the one the student wrote, which ends the reading.
  const chain = new Set(
    newestFirst
      .slice(from)
      .filter((message) => message.info.role === "user")
      .map((message) => message.info.id),
  )
  const turn = newestFirst
    .filter(
      (message): message is AssistantMessage => message.info.role === "assistant" && chain.has(message.info.parentID),
    )
    .reverse()
  return { user, turn }
})

type AssistantMessage = SessionV1.WithParts & { readonly info: SessionV1.Assistant }

/** Whether a user message is one the student wrote, rather than one compaction wrote to carry a turn on. */
function opensTurn(message: SessionV1.WithParts) {
  if (message.info.role !== "user") return false
  return !message.parts.some((part) => part.type === "compaction" || MessageV2.isCompactionContinue(part))
}

/**
 * The parts the subagents of a turn's `task` calls wrote while those calls ran, and those of the
 * subagents they delegated to in turn.
 *
 * ⚠ A DELEGATED READING IS THE TURN'S OWN. A subagent's course and web tools record their evidence on
 * its own session's tool parts, and the turn only sees what the subagent wrote back; read from the
 * turn alone, an answer resting on a search it delegated would show no source. The subagent's text is
 * not part of the answer, which is only what the turn itself wrote.
 *
 * ⚠ ONLY WHAT RAN INSIDE THE CALL. A later call can resume the same subagent session, so only the
 * messages written between the call's start and end are this call's. A call sent to the background
 * returned before its subagent finished, and is left out.
 *
 * ⚠ ONE SUBAGENT AFTER ANOTHER, ON PURPOSE. Each is a read of the local session store, which answers
 * synchronously, so reading them concurrently would not finish any sooner; a turn delegates to a
 * handful at most, and the selection's model call is what spends the attribution's time.
 */
function delegatedParts(
  sessions: Session.Interface,
  parts: readonly SessionV1.Part[],
): Effect.Effect<SessionV1.Part[]> {
  return Effect.forEach(parts, (part) =>
    Effect.gen(function* () {
      if (part.type !== "tool" || part.tool !== "task" || part.state.status !== "completed") return []
      const child = part.state.metadata?.sessionId
      if (typeof child !== "string" || part.state.metadata?.background === true) return []
      const steps = yield* stepsDuring(sessions, SessionID.make(child), part.state.time)
      return [...steps, ...(yield* delegatedParts(sessions, steps))]
    }),
  ).pipe(Effect.map((found) => found.flat()))
}

/** The parts of a session's assistant messages written within `during`, oldest first, summaries apart. */
const stepsDuring = Effect.fnUntraced(function* (
  sessions: Session.Interface,
  sessionID: SessionID,
  during: { readonly start: number; readonly end: number },
) {
  const newestFirst: SessionV1.WithParts[] = []
  // Read newest first, and stopped at the first message from before the call.
  yield* sessions
    .findMessage(sessionID, (message) => {
      if (message.info.time.created < during.start) return true
      if (message.info.time.created <= during.end) newestFirst.push(message)
      return false
    })
    .pipe(Effect.catch(() => Effect.succeed(Option.none<SessionV1.WithParts>())))
  return newestFirst
    .reverse()
    .flatMap((message) => (message.info.role === "assistant" && !message.info.summary ? message.parts : []))
})

/**
 * One selection round, read only as far as the reply limit.
 *
 * ⚠ A PROVIDER FAILURE FAILS THE ROUND RATHER THAN BEING JUDGED AS A REPLY. The model did not answer,
 * so there is nothing to correct, and a retry would be a resend.
 */
const round = Effect.fnUntraced(function* (input: {
  readonly llm: LLM.Interface
  readonly sessionID: SessionID
  readonly user: SessionV1.User
  readonly model: Provider.Model
  readonly conversation: readonly JolliSources.SelectionMessage[]
}) {
  const reply = { text: "", finishReason: undefined as string | undefined, oversized: false, failed: "" }
  // Inline reasoning is not the reply, so it does not count towards the reply's limit.
  const overflows = JolliSources.selectionMeter()
  yield* input.llm
    .stream({
      agent: SELECTOR,
      // The student's own per-message system text belongs to their turn, not to this brief.
      user: { ...input.user, system: undefined },
      system: [],
      small: true,
      tools: {},
      model: input.model,
      sessionID: input.sessionID,
      messages: input.conversation.map((message) => ({ role: message.role, content: message.content })),
    })
    .pipe(
      Stream.takeUntil((event) => {
        if (LLMEvent.is.textDelta(event)) {
          reply.text += event.text
          reply.oversized = overflows(reply.text)
        }
        if (LLMEvent.is.finish(event)) reply.finishReason = event.reason
        if (LLMEvent.is.providerError(event)) reply.failed = event.message
        return reply.oversized || !!reply.failed
      }),
      Stream.runDrain,
    )
  if (reply.failed || reply.finishReason === "error") {
    return yield* Effect.fail(new Error(`the selection model failed: ${reply.failed || "error"}`))
  }
  return { text: reply.text, finishReason: reply.finishReason, oversized: reply.oversized }
})
