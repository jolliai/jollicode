import { describe, expect, test } from "bun:test"
import { JolliSources } from "../src/jolli/sources"

const SEARCH = "jolliedu_search_remote_course_materials"
const READ = "jolliedu_get_remote_material_content"

const result = (text: string, isError = false) => ({ content: [{ type: "text", text }], isError })

describe("JolliSources.materialEvidenceOf", () => {
  test("preserves assignment worksheet links through evidence and source selection", () => {
    const url = "https://school.jolli.ai/learn/11/assignments/5"
    const evidence = JolliSources.materialEvidenceOf(
      READ,
      result(
        JSON.stringify({
          id: 5,
          title: "Pointers lab",
          docType: "assignment",
          assignment: { courseId: 11, url },
          lines: [{ number: 1, text: "Explain ownership." }],
        }),
      ),
    )
    expect(evidence).toEqual([
      { kind: "material", materialId: "5", title: "Pointers lab", text: "Explain ownership.", url },
    ])
    const sources = JolliSources.selectedSources(["s1"], [{ ref: "s1", evidence: evidence[0]! }])
    expect(JolliSources.answerSourcesFromMetadata({ answerSources: sources })).toEqual([
      { kind: "material", materialId: "5", title: "Pointers lab", url },
    ])
  })

  test("does not turn an invalid assignment URL into a source link", () => {
    const evidence = JolliSources.materialEvidenceOf(
      READ,
      result(
        JSON.stringify({
          id: 5,
          title: "Pointers lab",
          assignment: { courseId: 11, url: "javascript:alert(1)" },
          lines: [{ number: 1, text: "Explain ownership." }],
        }),
      ),
    )
    expect(evidence[0]).not.toHaveProperty("url")
  })

  /**
   * ⚠ AN ASSIGNMENT BINDING ONLY EVER ADDS A LINK. Written differently by a gateway — null, without a
   * course id, or not an object at all — it costs the link and never the material's evidence.
   */
  test.each([null, { url: "https://school.jolli.ai/learn/11/assignments/5" }, "assignment", { courseId: "11" }])(
    "keeps a read's evidence whatever its assignment binding holds: %j",
    (assignment) => {
      const evidence = JolliSources.materialEvidenceOf(
        READ,
        result(
          JSON.stringify({
            id: 5,
            title: "Pointers lab",
            assignment,
            lines: [{ number: 1, text: "Explain ownership." }],
          }),
        ),
      )
      expect(evidence).toEqual([
        {
          kind: "material",
          materialId: "5",
          title: "Pointers lab",
          text: "Explain ownership.",
          ...(typeof assignment === "object" && assignment !== null && "url" in assignment
            ? { url: assignment.url }
            : {}),
        },
      ])
    },
  )

  // A material's link is its own: named through a passage without it, it still comes from the one that has it.
  test("lists a material's link from whichever offered passage carries it", () => {
    const url = "https://school.jolli.ai/learn/11/assignments/5"
    const passage = { kind: "material" as const, materialId: "5", title: "Pointers lab", text: "Trace the pointers." }
    const sources = JolliSources.selectedSources(
      ["s1", "s2"],
      [
        { ref: "s1", evidence: passage },
        { ref: "s2", evidence: { ...passage, text: "Explain ownership.", url } },
      ],
    )
    expect(sources).toEqual([{ kind: "material", materialId: "5", title: "Pointers lab", url }])
    expect(
      JolliSources.selectedSources(
        ["s1"],
        [
          { ref: "s1", evidence: passage },
          { ref: "s2", evidence: { ...passage, text: "Explain ownership.", url } },
        ],
      ),
    ).toEqual([{ kind: "material", materialId: "5", title: "Pointers lab", url }])
  })

  // Any client can write a part's metadata: a bad link is dropped, never the material it was on.
  test("keeps a stored material source whose link is not http(s), without the link", () => {
    expect(
      JolliSources.answerSourcesFromMetadata({
        answerSources: [
          { kind: "material", materialId: "5", title: "Pointers lab", url: "javascript:alert(1)" },
          { kind: "web", url: "javascript:alert(1)", title: "Not a page" },
        ],
      }),
    ).toEqual([{ kind: "material", materialId: "5", title: "Pointers lab" }])
  })
  test("keeps each retrieved chunk a search returned, with its text", () => {
    const page = {
      results: [
        {
          id: 3,
          title: "Lecture 4: Pointers",
          evidenceKind: "retrieved_chunk",
          snippet: "A pointer holds an address.",
        },
        { id: 9, title: "Lab 2", evidenceKind: "retrieved_chunk", snippet: "Allocate with malloc." },
      ],
      nextOffset: null,
    }
    expect(JolliSources.materialEvidenceOf(SEARCH, result(JSON.stringify(page)))).toEqual([
      { kind: "material", materialId: "3", title: "Lecture 4: Pointers", text: "A pointer holds an address." },
      { kind: "material", materialId: "9", title: "Lab 2", text: "Allocate with malloc." },
    ])
  })

  test("does not offer a search preview, which the model still has to read", () => {
    const page = { results: [{ id: 3, title: "Lecture 4", evidenceKind: "search_preview", snippet: "..." }] }
    expect(JolliSources.materialEvidenceOf(SEARCH, result(JSON.stringify(page)))).toEqual([])
  })

  test("keeps the text a read returned, cut to the evidence limit", () => {
    const read = {
      id: 3,
      title: "Lecture 4: Pointers",
      lines: [
        { number: 1, text: "x".repeat(JolliSources.MAX_EVIDENCE_CHARS) },
        { number: 2, text: "tail" },
      ],
    }
    const [evidence] = JolliSources.materialEvidenceOf(READ, result(JSON.stringify(read)))
    expect(evidence).toMatchObject({ kind: "material", materialId: "3", title: "Lecture 4: Pointers" })
    expect(evidence?.text).toHaveLength(JolliSources.MAX_EVIDENCE_CHARS)
  })

  test("keeps each keyword passage independently through source selection, with the worksheet link", () => {
    const url = "https://school.jolli.ai/learn/11/assignments/5"
    const read = {
      id: 5,
      title: "Pointers lab",
      assignment: { courseId: 11, url },
      totalLines: 100,
      keywords: ["ownership"],
      matchedLines: 2,
      passages: [
        {
          from: 1,
          to: 1,
          matched: ["ownership"],
          matchLines: [1],
          lines: [{ number: 1, text: "x".repeat(JolliSources.MAX_EVIDENCE_CHARS + 100) }],
        },
        {
          from: 42,
          to: 43,
          matched: ["ownership"],
          matchLines: [42],
          lines: [
            { number: 42, text: "Explain ownership." },
            { number: 43, text: "Free the allocation once." },
          ],
        },
      ],
    }
    const evidence = JolliSources.materialEvidenceOf(READ, result(JSON.stringify(read)))
    expect(evidence).toEqual([
      {
        kind: "material",
        materialId: "5",
        title: "Pointers lab",
        text: "x".repeat(JolliSources.MAX_EVIDENCE_CHARS),
        url,
      },
      {
        kind: "material",
        materialId: "5",
        title: "Pointers lab",
        text: "Explain ownership.\nFree the allocation once.",
        url,
      },
    ])
    const candidates = JolliSources.turnCandidates([
      { type: "tool", tool: READ, state: { status: "completed", metadata: { evidence } } },
    ])
    expect(candidates).toHaveLength(2)
    expect(JolliSources.selectedSources(["s2"], candidates)).toEqual([
      { kind: "material", materialId: "5", title: "Pointers lab", url },
    ])
  })

  test("bounds the count and total text of evidence stored for a keyword read", () => {
    const read = {
      id: 3,
      title: "Lecture 4",
      passages: Array.from({ length: 40 }, (_, index) => ({
        lines: [{ text: `${index}:` + "x".repeat(JolliSources.MAX_EVIDENCE_CHARS) }],
      })),
    }
    const evidence = JolliSources.materialEvidenceOf(READ, result(JSON.stringify(read)))
    expect(evidence).toHaveLength(JolliSources.MAX_CANDIDATES)
    expect(evidence.reduce((total, item) => total + item.text.length, 0)).toBe(
      JolliSources.MAX_CANDIDATES * JolliSources.MAX_EVIDENCE_CHARS,
    )
    expect(evidence[0]?.text.startsWith("0:")).toBe(true)
    expect(evidence.at(-1)?.text.startsWith(`${JolliSources.MAX_CANDIDATES - 1}:`)).toBe(true)
  })

  test("keeps a material's keyword passage without an assignment binding", () => {
    const read = {
      id: 3,
      title: "Lecture 4: Pointers",
      keywords: ["heap"],
      passages: [{ lines: [{ number: 42, text: "A heap allocation remains live until freed." }] }],
    }
    expect(JolliSources.materialEvidenceOf(READ, result(JSON.stringify(read)))).toEqual([
      {
        kind: "material",
        materialId: "3",
        title: "Lecture 4: Pointers",
        text: "A heap allocation remains live until freed.",
      },
    ])
    expect(JolliSources.materialEvidenceOf(READ, result(JSON.stringify(read), true))).toEqual([])
  })

  test.each([
    { passages: [] },
    { passages: [{ lines: [] }] },
    { passages: [{ lines: [{ text: "  " }] }] },
    { passages: [{ lines: [{ text: 7 }] }] },
    { passages: [{ text: "missing lines" }] },
  ])("offers no evidence from empty or malformed keyword passages: %j", ({ passages }) => {
    const read = {
      id: 3,
      title: "Lecture 4",
      keywords: ["heap"],
      passages,
      note: "No line of this material holds these keywords.",
    }
    expect(JolliSources.materialEvidenceOf(READ, result(JSON.stringify(read)))).toEqual([])
  })

  test("offers nothing for a read with no text, a refusal, a failed call, or another tool", () => {
    const empty = { id: 3, title: "Scan", lines: [], message: "No text was extracted." }
    expect(JolliSources.materialEvidenceOf(READ, result(JSON.stringify(empty)))).toEqual([])
    expect(JolliSources.materialEvidenceOf(READ, result("That material is not available."))).toEqual([])
    const read = { id: 3, title: "x", lines: [{ number: 1, text: "y" }] }
    expect(JolliSources.materialEvidenceOf(READ, result(JSON.stringify(read), true))).toEqual([])
    expect(JolliSources.materialEvidenceOf("jolliedu_list_all_materials_in_remote_course", result("{}"))).toEqual([])
    expect(JolliSources.materialEvidenceOf(SEARCH, { content: "not an array" })).toEqual([])
  })
})

describe("JolliSources.evidenceFromMetadata", () => {
  test("keeps only well-formed entries of an untyped bag", () => {
    const good = { kind: "material" as const, materialId: "3", title: "Lecture 4", text: "..." }
    const metadata = { evidence: [good, { kind: "material", materialId: 3 }, "junk"], truncated: false }
    expect(JolliSources.evidenceFromMetadata(metadata)).toEqual([good])
    expect(JolliSources.evidenceFromMetadata({ evidence: "nope" })).toEqual([])
    expect(JolliSources.evidenceFromMetadata(undefined)).toEqual([])
  })
})

describe("JolliSources tool names", () => {
  test("tells the material tools and the course tools apart", () => {
    expect(JolliSources.isMaterialTool(SEARCH)).toBe(true)
    expect(JolliSources.isMaterialTool("jolliedu_get_conversation_context")).toBe(false)
    expect(JolliSources.isCourseTool("jolliedu_get_conversation_context")).toBe(true)
    expect(JolliSources.isCourseTool("webfetch")).toBe(false)
  })

  // The one gating rule both runtimes turn into deny rules of their own.
  test("withholds every course tool without a binding, and the assignment list where it is not read", () => {
    expect(JolliSources.withheldCourseTools({ bound: false, includeAssignments: true })).toEqual(
      JolliSources.COURSE_TOOLS,
    )
    expect(JolliSources.withheldCourseTools({ bound: true, includeAssignments: false })).toEqual([
      JolliSources.ASSIGNMENT_LIST_TOOL,
      JolliSources.WORK_LIST_TOOL,
      ...JolliSources.WORK_TOOLS,
    ])
    expect(JolliSources.withheldCourseTools({ bound: true, includeAssignments: true })).toEqual([])
  })

  // As the web chat serves them: a task reads what it uses, whatever the switch; any other chat its own work in the course.
  test("offers a task session the work it uses and never the course's list of the student's work", () => {
    expect(JolliSources.withheldCourseTools({ bound: true, includeAssignments: true, taskSession: true })).toEqual([
      JolliSources.WORK_LIST_TOOL,
    ])
    expect(JolliSources.withheldCourseTools({ bound: true, includeAssignments: false, taskSession: true })).toEqual([
      JolliSources.ASSIGNMENT_LIST_TOOL,
      JolliSources.WORK_LIST_TOOL,
    ])
    expect(JolliSources.COURSE_TOOLS).toEqual(
      expect.arrayContaining([JolliSources.WORK_LIST_TOOL, ...JolliSources.WORK_TOOLS]),
    )
  })
})

describe("JolliSources.turnAssignmentsUrl", () => {
  const url = "https://school.jolli.ai/learn/11/assignments"
  const text = (metadata: unknown) => ({ type: "text", text: "I cannot look up assignments.", metadata })

  test("reads the link the turn's answer carries, the newest where there are two", () => {
    expect(JolliSources.turnAssignmentsUrl([text({ assignmentsUrl: url })])).toBe(url)
    const newer = "https://school.jolli.ai/learn/12/assignments"
    expect(JolliSources.turnAssignmentsUrl([text({ assignmentsUrl: url }), text({ assignmentsUrl: newer })])).toBe(
      newer,
    )
  })

  test("draws nothing for a turn without one, or for a link that is not http(s)", () => {
    expect(JolliSources.turnAssignmentsUrl([text(undefined), text({ answerSources: [] })])).toBeUndefined()
    expect(JolliSources.turnAssignmentsUrl([text({ assignmentsUrl: "javascript:alert(1)" })])).toBeUndefined()
    expect(JolliSources.turnAssignmentsUrl([{ type: "tool", metadata: { assignmentsUrl: url } }])).toBeUndefined()
  })
})
