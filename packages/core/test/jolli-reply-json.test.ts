import { describe, expect, test } from "bun:test"
import { JolliReplyJson } from "../src/jolli/reply-json"

describe("JolliReplyJson.withoutInlineReasoning", () => {
  test("drops a closed reasoning block, and leaves a reply without one as it was", () => {
    expect(JolliReplyJson.withoutInlineReasoning('<think>maybe {"a":1}</think>\n{"b":2}')).toBe('\n{"b":2}')
    expect(JolliReplyJson.withoutInlineReasoning('{"b":2}')).toBe('{"b":2}')
  })

  test("drops everything up to a closing tag a chat template left without its opening one", () => {
    expect(JolliReplyJson.withoutInlineReasoning('weighing {s1}</think>{"b":2}')).toBe('{"b":2}')
  })

  test("drops reasoning still being written", () => {
    expect(JolliReplyJson.withoutInlineReasoning('{"b":2}<think>on second thought')).toBe('{"b":2}')
  })
})

describe("JolliReplyJson.parseObject", () => {
  test("reads the first object, past prose and inline reasoning", () => {
    expect(
      JolliReplyJson.parseObject('<think>{"usedSourceRefs":["s9"]}</think>Here: {"usedSourceRefs":["s1"]}'),
    ).toEqual({ kind: "ok", value: { usedSourceRefs: ["s1"] } })
  })

  test("repairs a string broken by the plain double quotes of a quotation", () => {
    expect(JolliReplyJson.parseObject('{"why":"the answer says "pointer" twice","usedSourceRefs":[]}')).toEqual({
      kind: "ok",
      value: { why: 'the answer says "pointer" twice', usedSourceRefs: [] },
    })
  })

  test("tells a reply with no object apart from one that cannot be read", () => {
    expect(JolliReplyJson.parseObject("none of them")).toEqual({ kind: "missing" })
    expect(JolliReplyJson.parseObject('{"usedSourceRefs":["s1"')).toEqual({ kind: "missing" })
    expect(JolliReplyJson.parseObject("{usedSourceRefs: [s1]}")).toEqual({ kind: "invalid" })
  })
})
