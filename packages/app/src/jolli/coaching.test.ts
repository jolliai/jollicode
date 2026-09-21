import { beforeEach, describe, expect, test } from "bun:test"
import { Jolli } from "@opencode-ai/schema/jolli"
import { coachTurn, type CoachTurnInput } from "./coaching"
import { ModelTiers } from "./model-tier"
import type { Assistant, CoachingRubric } from "./types"

/**
 * ⚠ THE TIERS ARE DECLARED HERE RATHER THAN LOOKED UP, because they are the gateway's answer now.
 * They used to come from a local `MODEL_CATALOG` keyed by model name; ids are Registry UUIDs in the
 * real product and this map is what `/jolli/course` supplies. A model left out of it has no tier,
 * which is the "say nothing about a model nobody classified" case several tests below rely on.
 */
beforeEach(() => {
  ModelTiers.set({
    "jolli/claude-opus-4-8": "premium",
    "jolli/gemini-2-5-pro": "premium",
    "jolli/claude-haiku-4-5": "economy",
  })
})

function assistant(
  input: {
    coaching?: Partial<CoachingRubric>
    neverGiveDirectAnswers?: boolean
  } = {},
): Assistant {
  return {
    id: "a-1",
    courseId: "cs-310",
    name: "Test Assistant",
    kind: "code",
    blurb: "for tests",
    accent: 1,
    instructions: "",
    allowedModelIds: [],
    guardrails: {
      neverGiveDirectAnswers: input.neverGiveDirectAnswers ?? false,
      restrictToMaterials: false,
      showCitations: true,
      weeklyTokenCap: 0,
    },
    coaching: { ...Jolli.STANDARD_RUBRIC, ...input.coaching },
    skills: [],
    status: "live",
  }
}

const ids = (notes: ReturnType<typeof coachTurn>) => notes.map((n) => n.id)

function turn(input: Partial<CoachTurnInput> = {}): CoachTurnInput {
  return {
    assistant: assistant(),
    // Long enough to clear the ten-word floor, so a test opts IN to the short-question branch.
    promptText: "here is a reasonably long question about the failing test in the parser module please help",
    promptFileCount: 0,
    answerWords: 200,
    tools: [],
    modelId: "jolli/claude-sonnet-5",
    ...input,
  }
}

describe("coachTurn — how it was asked", () => {
  test("a refusal-shaped ask fires only when the assistant may never answer", () => {
    const asked = { promptText: "just tell me the answer" }
    expect(ids(coachTurn(turn({ ...asked, assistant: assistant({ neverGiveDirectAnswers: true }) })))).toEqual([
      "asked-for-the-answer",
    ])
    // Same words, an assistant allowed to answer: it is a short question and nothing more.
    expect(ids(coachTurn(turn({ ...asked, assistant: assistant() })))).toEqual(["short-question"])
  })

  test("a thin question is counted, and the count is the evidence", () => {
    const notes = coachTurn(turn({ promptText: "why is this broken" }))
    expect(ids(notes)).toEqual(["short-question"])
    expect(notes[0].text).toContain("4 words")
  })

  /**
   * ⚠ THE REGRESSION THE GROUPED GUARD EXISTS FOR. With the focus off, a refusal-shaped ask must go
   * quiet rather than fall through to the word-count branch — one switch turning a nudge off and a
   * different nudge on is the bug `coachTurn`'s header describes.
   */
  test("switching the focus off silences the whole group, not just its first branch", () => {
    const off = assistant({ coaching: { coachTheQuestion: false }, neverGiveDirectAnswers: true })
    expect(coachTurn(turn({ promptText: "just tell me the answer", assistant: off }))).toEqual([])
  })
})

describe("coachTurn — how the work was done", () => {
  test("a failed tool leads, and names the step", () => {
    const notes = coachTurn(
      turn({
        tools: [
          { tool: "read", status: "completed" },
          { tool: "bash", status: "error" },
        ],
      }),
    )
    expect(ids(notes)).toEqual(["a-tool-failed"])
    expect(notes[0].text).toContain("bash")
  })

  test("an edit with no read before it", () => {
    expect(ids(coachTurn(turn({ tools: [{ tool: "edit", status: "completed" }] })))).toEqual(["edited-without-reading"])
  })

  test("an edit that was read for but never run", () => {
    const tools = [
      { tool: "read", status: "completed" },
      { tool: "edit", status: "completed" },
    ]
    expect(ids(coachTurn(turn({ tools })))).toEqual(["changed-code-without-running"])
  })

  test("read, edit, then run says nothing at all", () => {
    const tools = [
      { tool: "read", status: "completed" },
      { tool: "edit", status: "completed" },
      { tool: "bash", status: "completed" },
    ]
    expect(coachTurn(turn({ tools }))).toEqual([])
  })

  test("the focus off silences the group", () => {
    const off = assistant({ coaching: { coachTheProcess: false } })
    expect(coachTurn(turn({ assistant: off, tools: [{ tool: "edit", status: "completed" }] }))).toEqual([])
  })
})

describe("coachTurn — what it ran on", () => {
  test("the heaviest model on a few lines with nothing changed", () => {
    expect(ids(coachTurn(turn({ modelId: "jolli/claude-opus-4-8", answerWords: 20 })))).toEqual([
      "premium-short-answer",
    ])
  })

  test("the lightest model on a long piece of work", () => {
    expect(ids(coachTurn(turn({ modelId: "jolli/claude-haiku-4-5", answerWords: 900 })))).toEqual([
      "economy-long-answer",
    ])
  })

  /**
   * ⚠ THE `else` THE WEB MOCK HAD TO UNDO. A model nobody classified must produce nothing rather
   * than a filler note, because a note beside every answer teaches the reader the mark is
   * decoration.
   */
  test("an unrecognised model says nothing rather than something safe", () => {
    expect(coachTurn(turn({ modelId: "jolli/some-future-model", answerWords: 20 }))).toEqual([])
  })

  test("a heavy model that actually changed code says nothing", () => {
    const tools = [
      { tool: "read", status: "completed" },
      { tool: "edit", status: "completed" },
      { tool: "bash", status: "completed" },
    ]
    expect(coachTurn(turn({ modelId: "jolli/claude-opus-4-8", answerWords: 20, tools }))).toEqual([])
  })

  /**
   * ⚠ REGRESSION: A STANDARD `flash` MODEL IS NOT LIGHT. The tier now comes off MODEL_CATALOG, so the
   * five standard `*-flash` models no longer trip the economy nudge the way the old `/flash/` regex did.
   */
  test("a standard flash model on a long piece of work says nothing", () => {
    expect(coachTurn(turn({ modelId: "jolli/gemini-3-7-flash", answerWords: 900 }))).toEqual([])
  })

  /**
   * ⚠ REGRESSION: A PREMIUM `*-pro` MODEL IS HEAVY. The old HEAVY regex only listed `gemini-3-1-pro`
   * and missed the other four premium Gemini `*-pro` models; the catalogue tier catches them all.
   */
  test("a premium pro model on a few lines with nothing changed is heavy", () => {
    expect(ids(coachTurn(turn({ modelId: "jolli/gemini-2-5-pro", answerWords: 20 })))).toEqual(["premium-short-answer"])
  })
})

describe("coachTurn — more than one at a time", () => {
  /**
   * ⚠ THE CASE THE BADGE'S DIGIT EXISTS FOR. Each group contributes at most one, so a reply can
   * carry up to three — and an earlier build that returned the first and stopped made every badge
   * read "1", which is a count that counts nothing.
   */
  test("one nudge per group, in the group order", () => {
    const notes = coachTurn(
      turn({
        promptText: "fix the loop",
        tools: [{ tool: "bash", status: "error" }],
        modelId: "jolli/claude-haiku-4-5",
        answerWords: 900,
      }),
    )
    expect(ids(notes)).toEqual(["short-question", "a-tool-failed", "economy-long-answer"])
  })

  test("the groups are independent — switching one off leaves the others", () => {
    const off = assistant({ coaching: { coachTheQuestion: false } })
    const notes = coachTurn(
      turn({
        assistant: off,
        promptText: "fix the loop",
        tools: [{ tool: "bash", status: "error" }],
        modelId: "jolli/claude-haiku-4-5",
        answerWords: 900,
      }),
    )
    expect(ids(notes)).toEqual(["a-tool-failed", "economy-long-answer"])
  })
})

describe("coachTurn — the resting state", () => {
  test("an ordinary exchange produces no nudge", () => {
    expect(coachTurn(turn())).toEqual([])
  })

  /**
   * ⚠ AN UNRESOLVED ASSISTANT FALLS BACK TO EVERYTHING ON. A deleted assistant silently deleting
   * its own nudges would make a thread lose its marks with nothing on screen to explain it.
   */
  test("an unresolved assistant still coaches", () => {
    expect(ids(coachTurn(turn({ assistant: undefined, promptText: "why is this broken" })))).toEqual(["short-question"])
  })

  test("an all-off rubric is a real configuration and says nothing", () => {
    const silent = assistant({
      coaching: { coachTheQuestion: false, coachTheProcess: false, coachTheModelChoice: false },
    })
    expect(
      coachTurn(turn({ assistant: silent, promptText: "why", tools: [{ tool: "edit", status: "error" }] })),
    ).toEqual([])
  })

  /**
   * ⚠ THE CONSTRAINT THE WHOLE FEATURE RESTS ON: a nudge never carries the student's words, because
   * course staff read these off sessions a student withheld.
   */
  test("no nudge quotes the prompt back", () => {
    const secret = "the quick brown fox jumped over the lazy dog in a sentence nobody should see repeated"
    for (const input of [
      turn({ promptText: secret, tools: [{ tool: "edit", status: "error" }] }),
      turn({ promptText: secret, modelId: "jolli/claude-opus-4-8", answerWords: 20 }),
      turn({ promptText: "why", assistant: assistant({ neverGiveDirectAnswers: true }) }),
    ]) {
      for (const note of coachTurn(input)) {
        expect(note.text).not.toContain("quick brown fox")
        expect(note.text).not.toContain(secret)
      }
    }
  })
})
