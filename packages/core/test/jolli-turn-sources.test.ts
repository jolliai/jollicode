import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { JolliSources } from "../src/jolli/sources"

type Part = JolliSources.TurnPart

function tool(name: string, state: NonNullable<Part["state"]>): Part {
  return { type: "tool", tool: name, state }
}

function completed(
  name: string,
  over: { input?: Record<string, unknown>; output?: string; metadata?: unknown } = {},
): Part {
  return tool(name, {
    status: "completed",
    input: over.input ?? {},
    output: over.output ?? "",
    metadata: over.metadata ?? {},
  })
}

const lecture = { kind: "material" as const, materialId: "3", title: "Lecture 4", text: "A pointer holds an address." }
const read = (evidence = [lecture]) => completed("jolliedu_get_remote_material_content", { metadata: { evidence } })

describe("JolliSources.turnCandidates", () => {
  test("offers each passage the course tools recorded, and the same passage once", () => {
    const candidates = JolliSources.turnCandidates([
      completed("jolliedu_search_remote_course_materials", { metadata: { evidence: [lecture] } }),
      read([{ ...lecture, text: "Dereference with *." }]),
      read([lecture]),
    ])
    expect(candidates).toEqual([
      { ref: "s1", evidence: lecture },
      { ref: "s2", evidence: { ...lecture, text: "Dereference with *." } },
    ])
  })

  test("keeps a later read of the same material whole, instead of cutting it away behind the first", () => {
    const page1 = { ...lecture, text: "a".repeat(JolliSources.MAX_EVIDENCE_CHARS) }
    const page3 = { ...lecture, text: "Pointer arithmetic moves by the element size." }
    const candidates = JolliSources.turnCandidates([read([page1]), read([page3])])
    expect(candidates.map((candidate) => candidate.evidence.text)).toEqual([page1.text, page3.text])
  })

  test("offers a fetched page and each result a web search listed", () => {
    const candidates = JolliSources.turnCandidates([
      completed("webfetch", { input: { url: "https://docs.python.org/3/tutorial/" }, output: "The tutorial." }),
      completed("websearch", { output: "https://a.example/one First result.\nhttps://b.example/two Second result." }),
      completed("webfetch", { input: { url: "file:///etc/passwd" }, output: "secret" }),
    ])
    expect(candidates.map((candidate) => candidate.evidence)).toEqual([
      { kind: "web", url: "https://docs.python.org/3/tutorial/", title: "docs.python.org", text: "The tutorial." },
      { kind: "web", url: "https://a.example/one", title: "a.example", text: "First result." },
      { kind: "web", url: "https://b.example/two", title: "b.example", text: "Second result." },
    ])
  })

  test("ignores calls that did not complete, uploads, and every other tool", () => {
    const running = tool("jolliedu_get_remote_material_content", {
      status: "running",
      input: {},
      metadata: { evidence: [lecture] },
    })
    const upload = completed("jolliedu_read_user_attachment", { metadata: { evidence: [lecture] } })
    expect(JolliSources.turnCandidates([running, upload, completed("bash", { output: "https://x.example" })])).toEqual(
      [],
    )
  })

  test("stops at the candidate limit", () => {
    const many = Array.from({ length: JolliSources.MAX_CANDIDATES + 5 }, (_, index) => ({
      ...lecture,
      materialId: String(index),
    }))
    expect(JolliSources.turnCandidates([read(many)])).toHaveLength(JolliSources.MAX_CANDIDATES)
  })
})

describe("JolliSources.turnAnswer", () => {
  test("joins the model's text across every step of the turn", () => {
    const parts: Part[] = [
      { type: "text", text: "Let me look." },
      read(),
      { type: "text", text: "A pointer holds an address." },
      { type: "text", text: "injected", synthetic: true },
    ]
    expect(JolliSources.turnAnswer(parts)).toBe("Let me look.\n\nA pointer holds an address.")
  })

  test("keeps the end of a turn longer than the limit, where the conclusion is", () => {
    const answer = JolliSources.turnAnswer([
      { type: "text", text: `${"a".repeat(JolliSources.MAX_ANSWER_CHARS)}CONCLUSION` },
    ])
    expect(answer).toHaveLength(JolliSources.MAX_ANSWER_CHARS)
    expect(answer.endsWith("CONCLUSION")).toBe(true)
  })
})

describe("JolliSources.judgeSelection", () => {
  const stop = (text: string) => ({ text, finishReason: "stop", oversized: false })

  test("reads the selection even with prose around it", () => {
    expect(JolliSources.judgeSelection(stop('Here: {"usedSourceRefs":["s1","s2"]} done'))).toEqual({
      kind: "ok",
      refs: ["s1", "s2"],
    })
  })

  test("names every problem, and replays the reply so the retry can correct it", () => {
    const verdict = JolliSources.judgeSelection(stop('{"usedSourceRefs":"s1"}'))
    expect(verdict.kind).toBe("retry")
    if (verdict.kind !== "retry") return
    expect(verdict.problems).toEqual(["usedSourceRefs: expected an array of strings"])
    expect(verdict.followUp[0]).toEqual({ role: "assistant", content: '{"usedSourceRefs":"s1"}' })
    expect(verdict.followUp[1]?.content).toContain("usedSourceRefs: expected an array of strings")
  })

  test("says when there is no JSON, or it cannot be parsed", () => {
    expect(JolliSources.judgeSelection(stop("none of them"))).toMatchObject({
      kind: "retry",
      problems: ["the reply contained no complete JSON object"],
    })
    expect(JolliSources.judgeSelection(stop("{usedSourceRefs: [s1]}"))).toMatchObject({
      kind: "retry",
      problems: ["the JSON object could not be parsed"],
    })
  })

  test("does not replay a cut-off or oversized reply", () => {
    for (const reply of [
      { text: '{"usedSourceRefs":["s1"', finishReason: "length", oversized: false },
      { text: "x".repeat(3000), finishReason: undefined, oversized: true },
    ]) {
      const verdict = JolliSources.judgeSelection(reply)
      expect(verdict.kind).toBe("retry")
      if (verdict.kind !== "retry") continue
      expect(verdict.followUp.map((message) => message.role)).toEqual(["user"])
    }
  })

  test("treats a reply that never finished as fatal, not as a format problem", () => {
    expect(JolliSources.judgeSelection({ text: "", finishReason: undefined, oversized: false }).kind).toBe("fatal")
  })

  test("reads a reply whose finish the provider did not name, and retries it only when it is not whole", () => {
    const unknown = (text: string) => ({ text, finishReason: "unknown", oversized: false })
    expect(JolliSources.judgeSelection(unknown('{"usedSourceRefs":["s1"]}'))).toEqual({ kind: "ok", refs: ["s1"] })
    expect(JolliSources.judgeSelection(unknown('{"usedSourceRefs":["s1"'))).toMatchObject({
      kind: "retry",
      problems: ["the reply contained no complete JSON object"],
    })
  })

  test("reads past reasoning the model wrote into its reply, and does not replay it", () => {
    const reasoning = '<think>The answer is about pointers, so {"usedSourceRefs":["s2"]} is wrong.</think>'
    expect(JolliSources.judgeSelection(stop(`${reasoning}\n{"usedSourceRefs":["s1"]}`))).toEqual({
      kind: "ok",
      refs: ["s1"],
    })
    // A chat template that opened the block itself sends only its end.
    expect(JolliSources.judgeSelection(stop('Weighing s1 {first}.</think>{"usedSourceRefs":[]}'))).toEqual({
      kind: "ok",
      refs: [],
    })
    const verdict = JolliSources.judgeSelection(stop(`${reasoning} none of them`))
    expect(verdict.kind).toBe("retry")
    if (verdict.kind !== "retry") return
    expect(verdict.followUp[0]).toEqual({ role: "assistant", content: "none of them" })
  })
})

describe("JolliSources.selectionOverflows", () => {
  test("does not count inline reasoning towards the reply's limit, but bounds it too", () => {
    const reply = '{"usedSourceRefs":["s1"]}'
    const thinking = `<think>${"x".repeat(JolliSources.MAX_SELECTION_CHARS * 4)}</think>`
    expect(JolliSources.selectionOverflows(thinking + reply)).toBe(false)
    expect(JolliSources.selectionOverflows(`<think>${"x".repeat(JolliSources.MAX_SELECTION_CHARS * 4)}`)).toBe(false)
    expect(JolliSources.selectionOverflows("y".repeat(JolliSources.MAX_SELECTION_CHARS + 1))).toBe(true)
    const endless = `<think>${"x".repeat(JolliSources.MAX_SELECTION_CHARS + JolliSources.MAX_SELECTION_REASONING_CHARS)}`
    expect(JolliSources.selectionOverflows(endless)).toBe(true)
  })
})

describe("JolliSources.select", () => {
  const candidates = JolliSources.turnCandidates([read([lecture, { ...lecture, materialId: "9", title: "Lab 2" }])])
  const reply = (text: string) => ({ text, finishReason: "stop", oversized: false })

  test("keeps only offered refs, once each, in the order named", async () => {
    const result = await Effect.runPromise(
      JolliSources.select({
        answer: "A pointer holds an address.",
        candidates,
        complete: () => Effect.succeed(reply('{"usedSourceRefs":["s2","s9","s2"]}')),
      }),
    )
    expect(result).toEqual({ sources: [{ kind: "material", materialId: "9", title: "Lab 2" }], attempts: 1 })
  })

  test("lists a material picked through several of its passages once", () => {
    const passages = JolliSources.turnCandidates([read([lecture]), read([{ ...lecture, text: "Dereference with *." }])])
    expect(JolliSources.selectedSources(["s2", "s1"], passages)).toEqual([
      { kind: "material", materialId: "3", title: "Lecture 4" },
    ])
  })

  test("retries once with the problems, and succeeds on the corrected reply", async () => {
    const seen: (readonly JolliSources.SelectionMessage[])[] = []
    const replies = [reply("not json"), reply('{"usedSourceRefs":["s1"]}')]
    const result = await Effect.runPromise(
      JolliSources.select({
        answer: "A pointer holds an address.",
        candidates,
        complete: (messages) => {
          seen.push(messages)
          return Effect.succeed(replies[seen.length - 1] ?? reply(""))
        },
      }),
    )
    expect(result.attempts).toBe(2)
    expect(seen[1]?.map((message) => message.role)).toEqual(["user", "assistant", "user"])
    expect(seen[1]?.[2]?.content).toContain("the reply contained no complete JSON object")
  })

  test("fails after the corrected retry fails too, with every problem", async () => {
    const exit = await Effect.runPromiseExit(
      JolliSources.select({ answer: "x", candidates, complete: () => Effect.succeed(reply("still not json")) }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    const error = Exit.isFailure(exit) ? exit.cause.toString() : ""
    expect(error).toContain("Jolli.SourceSelectionError")
  })

  test("sends the answer and the candidates as data in one user message", () => {
    const message = JolliSources.selectionRequest("the answer", candidates)
    expect(message.role).toBe("user")
    expect(JSON.parse(message.content)).toEqual({
      answer: "the answer",
      candidates: [
        { ref: "s1", title: "Lecture 4", evidence: lecture.text },
        { ref: "s2", title: "Lab 2", evidence: lecture.text },
      ],
    })
  })
})

describe("JolliSources.turnSources", () => {
  const picked = [
    { kind: "material", materialId: "3", title: "Lecture 4" },
    { kind: "web", url: "https://a.example/one", title: "a.example" },
  ]

  test("draws what the selection picked for the answer", () => {
    const parts: Part[] = [read(), { type: "text", text: "answer", metadata: { answerSources: picked } }]
    expect(JolliSources.turnSources(parts, { showCitations: true })).toEqual({
      materials: [{ kind: "material", materialId: "3", title: "Lecture 4" }],
      web: [{ kind: "web", url: "https://a.example/one", title: "a.example" }],
    })
  })

  test("draws nothing before the selection lands, when it picked nothing, or when citations are hidden", () => {
    expect(
      JolliSources.turnSources([read(), { type: "text", text: "answer" }], { showCitations: true }),
    ).toBeUndefined()
    const none: Part = { type: "text", text: "answer", metadata: { answerSources: [] } }
    expect(JolliSources.turnSources([none], { showCitations: true })).toBeUndefined()
    const shown: Part = { type: "text", text: "answer", metadata: { answerSources: picked } }
    expect(JolliSources.turnSources([shown], { showCitations: false })).toBeUndefined()
  })
})
