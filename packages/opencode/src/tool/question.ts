import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Question } from "../question"
import { JolliInput } from "../session/jolli-input"
import { TypedText } from "../session/typed-text"
import DESCRIPTION from "./question.txt"

export const Parameters = Schema.Struct({
  questions: Schema.mutable(Schema.Array(Question.Prompt)).annotate({ description: "Questions to ask" }),
})

type Metadata = {
  answers: ReadonlyArray<Question.Answer>
  [JolliInput.METADATA_KEY]: JolliInput.Stamp
}

export const QuestionTool = Tool.define<typeof Parameters, Metadata, Question.Service>(
  "question",
  Effect.gen(function* () {
    const question = yield* Question.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const answers = yield* question.ask({
            sessionID: ctx.sessionID,
            questions: params.questions,
            tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
          })

          // The answers are what the student chose or typed, so the Jolli gateway is told where they landed.
          //
          // ⚠ A CHOSEN OPTION IS DECLARED TOO, though its label is the model's own text: an answer is the labels
          // picked and the text typed, side by side, and the declaration covers it whole. Nothing goes out
          // unchecked for it — the cost runs the other way. A label holds what the model wrote from text whose
          // values it saw replaced, and they come back restored and already bound, so the gateway searches it for
          // nothing new; at worst it misreads a word of it as a name, and the model sees a placeholder in its own
          // option. Declaring only what was typed means leaving out each answer equal to one of the question's
          // `options` labels.
          const output = TypedText.join([
            "User has answered your questions: ",
            ...params.questions.flatMap((q, i) => [
              `${i === 0 ? "" : ", "}"${q.question}"="`,
              answers[i]?.length ? TypedText.typed(answers[i].join(", ")) : "Unanswered",
              '"',
            ]),
            ". You can now continue with the user's answers in mind.",
          ])

          return {
            title: `Asked ${params.questions.length} question${params.questions.length > 1 ? "s" : ""}`,
            output: output.text,
            metadata: {
              answers,
              [JolliInput.METADATA_KEY]: { length: output.text.length, ranges: output.ranges },
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
