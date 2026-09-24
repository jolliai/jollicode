import { describe, expect, test } from "bun:test"
import { coachProse, coachProseBrief, coachProseRequest, type CoachProseWriter } from "./coaching-prose"
import type { CoachTrigger } from "./coaching"

const TRIGGER: CoachTrigger = {
  id: "short-question",
  focus: "coachTheQuestion",
  text: "Your question ran to 4 words. A short question gets a general answer.",
}

const PROMPT = "why is this broken"
const REPLY = "Because the parser never sees the closing brace."

const build = (staff: boolean) =>
  coachProseRequest({
    trigger: TRIGGER,
    instructions: "Keep it to one sentence.",
    staffCanRead: staff,
    prompt: PROMPT,
    reply: REPLY,
  })

describe("the privacy rule", () => {
  test("a staff-shared session lets the writer see the exchange", () => {
    expect(build(true).exchange).toEqual({ prompt: PROMPT, reply: REPLY })
  })

  /**
   * ⚠ THE INVARIANT THE WHOLE FEATURE RESTS ON. Course staff read nudges off sessions they cannot
   * open, so on a withheld session no model may see the body — the derived sentence stands.
   */
  test("a withheld session never hands the exchange over", () => {
    expect(build(false).exchange).toBeUndefined()
  })

  test("and the brief for a withheld session contains neither side of it", () => {
    const brief = coachProseBrief(build(false))
    expect(brief).not.toContain(PROMPT)
    expect(brief).not.toContain(REPLY)
    expect(brief).toContain(TRIGGER.text)
  })

  test("the brief for a shared session carries both, and the instructor's voice", () => {
    const brief = coachProseBrief(build(true))
    expect(brief).toContain(PROMPT)
    expect(brief).toContain(REPLY)
    expect(brief).toContain("Keep it to one sentence.")
  })
})

describe("the derived sentence is the floor", () => {
  const cases: [string, CoachProseWriter | undefined][] = [
    ["no writer at all", undefined],
    [
      "a writer that throws",
      async () => {
        throw new Error("gateway down")
      },
    ],
    ["a writer that returns nothing", async () => undefined],
    ["a writer that returns whitespace", async () => "   "],
    ["a writer that returns an essay", async () => "x".repeat(401)],
  ]
  for (const [name, writer] of cases) {
    test(`${name} leaves the derived nudge standing`, async () => {
      expect(await coachProse(build(true), writer)).toBe(TRIGGER.text)
    })
  }

  test("a good writer wins", async () => {
    const sharpened = "Four words gave it nothing to work with — name the error you saw next time."
    expect(await coachProse(build(true), async () => sharpened)).toBe(sharpened)
  })
})
