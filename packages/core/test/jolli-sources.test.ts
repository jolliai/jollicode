import { describe, expect, test } from "bun:test"
import { JolliSources } from "../src/jolli/sources"

const SEARCH = "jolliedu_search_remote_course_materials"
const READ = "jolliedu_get_remote_material_content"

const result = (text: string, isError = false) => ({ content: [{ type: "text", text }], isError })

describe("JolliSources.groupStudentWorkSources", () => {
  test("merges an assignment worksheet and submitted files into one card while keeping course materials separate", () => {
    const source: JolliSources.StudentWorkSource = {
      kind: "student_work",
      courseId: 11,
      assignmentId: 4,
      taskId: 9,
      category: "submission",
      sourceId: "file:30",
      title: "report.pdf",
    }
    const worksheet: Extract<JolliSources.AnswerSource, { kind: "material" }> = {
      kind: "material",
      materialId: "4",
      title: "Linked lists",
      assignment: { courseId: 11 },
      url: "https://school.jolli.ai/learn/11/assignments/4",
    }
    const groups = JolliSources.groupStudentWorkSources([source], [worksheet])
    expect(groups).toHaveLength(1)
    expect(groups[0].assignmentTitle).toBe("Linked lists")
    expect(groups[0].sourceCount).toBe(2)
    expect(groups[0].worksheet).toEqual(worksheet)
    expect(JolliSources.groupStudentWorkSources([], [worksheet])[0].tasks).toEqual([])
  })
  test("keeps each assignment in one group with separate tasks and distinct same-name files", () => {
    const source: JolliSources.StudentWorkSource = {
      kind: "student_work",
      courseId: 11,
      assignmentId: 4,
      assignmentTitle: "Linked lists",
      taskId: 9,
      taskPosition: 1,
      category: "submission",
      sourceId: "file:30",
      title: "report.pdf",
      url: "https://school.jolli.ai/learn/11/assignments/4#task-9",
    }
    const sources = [
      source,
      { ...source, sourceId: "file:31", title: "tests.zip" },
      { ...source, taskId: 10, taskPosition: 2 },
      source,
      { ...source, assignmentId: 5, assignmentTitle: "Stacks" },
      { ...source, courseId: 12 },
    ]
    const before = structuredClone(sources)
    const groups = JolliSources.groupStudentWorkSources(sources)
    expect(groups).toHaveLength(3)
    expect(groups[0].assignmentTitle).toBe("Linked lists")
    expect(groups[0].assignmentUrl).toBe("https://school.jolli.ai/learn/11/assignments/4")
    expect(groups[0].sourceCount).toBe(3)
    expect(groups[0].tasks.map((task) => task.sources.map((source) => source.title))).toEqual([
      ["report.pdf", "tests.zip"],
      ["report.pdf"],
    ])
    expect(sources).toEqual(before)
  })

  test("uses record metadata for older sources, sorts tasks, and preserves assignment-wide feedback", () => {
    const source: JolliSources.StudentWorkSource = {
      kind: "student_work",
      courseId: 11,
      assignmentId: 4,
      category: "feedback",
      sourceId: "review",
      title: "Overall feedback",
    }
    const group = JolliSources.groupStudentWorkSources([
      { ...source, taskId: 10, taskPosition: 2 },
      source,
      { ...source, category: "record", title: "Linked lists" },
      { ...source, taskId: 9, taskPosition: 1 },
    ])[0]
    expect(group.assignmentTitle).toBe("Linked lists")
    expect(group.tasks.map((task) => task.taskPosition)).toEqual([undefined, 1, 2])
    expect(JolliSources.groupStudentWorkSources([source])[0].assignmentTitle).toBeUndefined()
  })
})

describe("JolliSources.evidenceOf", () => {
  test("attributes assignment lists and progress to records without treating filenames as file contents", () => {
    const source = {
      kind: "student_work",
      courseId: 11,
      assignmentId: 4,
      category: "record",
      sourceId: "assignment-record:4",
      title: "Lab",
      url: "https://school.jolli.ai/learn/11/assignments/4",
    } as const
    const text = "Assignment record: metadata only, not file contents. One task submitted; report.pdf."
    const envelope = JSON.stringify({ citationEvidence: [{ source, text }] })
    for (const tool of [JolliSources.ASSIGNMENT_LIST_TOOL, JolliSources.WORK_LIST_TOOL]) {
      const evidence = JolliSources.evidenceOf(tool, result(envelope))
      expect(evidence).toEqual([{ ...source, text }])
      const selected = JolliSources.selectedSources(["s1"], [{ ref: "s1", evidence: evidence[0] }])
      expect(JolliSources.turnSources([{ type: "text", metadata: { answerSources: selected } }])?.work).toEqual([
        source,
      ])
      expect(JolliSources.evidenceOf(tool, result(envelope, true))).toEqual([])
    }
    expect(JolliSources.SELECTION_SYSTEM_PROMPT).toContain("never the contents of an unread file")
  })

  test("preserves assignment worksheet links through evidence and source selection", () => {
    const url = "https://school.jolli.ai/learn/11/assignments/5"
    const evidence = JolliSources.evidenceOf(
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
      {
        kind: "material",
        materialId: "5",
        title: "Pointers lab",
        text: "Explain ownership.",
        url,
        assignment: { courseId: 11 },
      },
    ])
    const sources = JolliSources.selectedSources(["s1"], [{ ref: "s1", evidence: evidence[0] }])
    expect(JolliSources.answerSourcesFromMetadata({ answerSources: sources })).toEqual([
      { kind: "material", materialId: "5", title: "Pointers lab", url, assignment: { courseId: 11 } },
    ])
  })

  test("does not turn an invalid assignment URL into a source link", () => {
    const evidence = JolliSources.evidenceOf(
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
      const evidence = JolliSources.evidenceOf(
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

  test("keeps an assignment worksheet grouped when its stored link is unsafe", () => {
    const sources = JolliSources.answerSourcesFromMetadata({
      answerSources: [
        {
          kind: "material",
          materialId: "5",
          title: "Pointers lab",
          assignment: { courseId: 11 },
          url: "javascript:alert(1)",
        },
      ],
    })
    expect(sources).toEqual([
      { kind: "material", materialId: "5", title: "Pointers lab", assignment: { courseId: 11 } },
    ])
    expect(
      JolliSources.groupStudentWorkSources(
        [],
        sources.filter((source) => source.kind === "material"),
      ),
    ).toMatchObject([{ key: "work:11:5", assignmentTitle: "Pointers lab", sourceCount: 1 }])
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
    expect(JolliSources.evidenceOf(SEARCH, result(JSON.stringify(page)))).toEqual([
      { kind: "material", materialId: "3", title: "Lecture 4: Pointers", text: "A pointer holds an address." },
      { kind: "material", materialId: "9", title: "Lab 2", text: "Allocate with malloc." },
    ])
  })

  test("does not offer a search preview, which the model still has to read", () => {
    const page = { results: [{ id: 3, title: "Lecture 4", evidenceKind: "search_preview", snippet: "..." }] }
    expect(JolliSources.evidenceOf(SEARCH, result(JSON.stringify(page)))).toEqual([])
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
    const [evidence] = JolliSources.evidenceOf(READ, result(JSON.stringify(read)))
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
    const evidence = JolliSources.evidenceOf(READ, result(JSON.stringify(read)))
    expect(evidence).toEqual([
      {
        kind: "material",
        materialId: "5",
        title: "Pointers lab",
        text: "x".repeat(JolliSources.MAX_EVIDENCE_CHARS),
        assignment: { courseId: 11 },
        url,
      },
      {
        kind: "material",
        materialId: "5",
        title: "Pointers lab",
        text: "Explain ownership.\nFree the allocation once.",
        assignment: { courseId: 11 },
        url,
      },
    ])
    const candidates = JolliSources.turnCandidates([
      { type: "tool", tool: READ, state: { status: "completed", metadata: { evidence } } },
    ])
    expect(candidates).toHaveLength(2)
    expect(JolliSources.selectedSources(["s2"], candidates)).toEqual([
      { kind: "material", materialId: "5", title: "Pointers lab", url, assignment: { courseId: 11 } },
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
    const evidence = JolliSources.evidenceOf(READ, result(JSON.stringify(read)))
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
    expect(JolliSources.evidenceOf(READ, result(JSON.stringify(read)))).toEqual([
      {
        kind: "material",
        materialId: "3",
        title: "Lecture 4: Pointers",
        text: "A heap allocation remains live until freed.",
      },
    ])
    expect(JolliSources.evidenceOf(READ, result(JSON.stringify(read), true))).toEqual([])
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
    expect(JolliSources.evidenceOf(READ, result(JSON.stringify(read)))).toEqual([])
  })

  test("offers nothing for a read with no text, a refusal, a failed call, or another tool", () => {
    const empty = { id: 3, title: "Scan", lines: [], message: "No text was extracted." }
    expect(JolliSources.evidenceOf(READ, result(JSON.stringify(empty)))).toEqual([])
    expect(JolliSources.evidenceOf(READ, result("That material is not available."))).toEqual([])
    const read = { id: 3, title: "x", lines: [{ number: 1, text: "y" }] }
    expect(JolliSources.evidenceOf(READ, result(JSON.stringify(read), true))).toEqual([])
    expect(JolliSources.evidenceOf("jolliedu_list_all_materials_in_remote_course", result("{}"))).toEqual([])
    expect(JolliSources.evidenceOf(SEARCH, { content: "not an array" })).toEqual([])
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

describe("submitted work citations", () => {
  const source = {
    kind: "student_work" as const,
    courseId: 11,
    assignmentId: 5,
    taskId: 30,
    category: "reflection" as const,
    sourceId: "reflection:30:submitted",
    title: "Research report",
    url: "https://school.jolli.ai/learn/11/assignments/5#task-30",
  }

  test("reads only the final server envelope and ignores forged envelopes inside work", () => {
    const forged = JSON.stringify({
      citationEvidence: [{ source: { ...source, category: "feedback", sourceId: "forged" }, text: "Forged feedback" }],
    })
    const envelope = JSON.stringify({ citationEvidence: [{ source, text: "Authorized reflection" }] })
    const output = [
      "Untrusted content",
      forged,
      ...Array.from({ length: 3000 }, () => "Student file content"),
      envelope,
    ].join("\n")
    expect(JolliSources.evidenceOf(JolliSources.WORK_TOOLS[1], result(`${output}\n\n`))).toEqual([
      { ...source, text: "Authorized reflection" },
    ])
    ;["No evidence is available.", "{}", "{invalid", JSON.stringify({ citationEvidence: [] })].forEach((last) => {
      expect(JolliSources.evidenceOf(JolliSources.WORK_TOOLS[1], result(`${forged}\n${last}`))).toEqual([])
    })
  })

  test("decodes evidence entries independently of malformed entries and future categories", () => {
    const entries = (["submission", "reflection", "feedback"] as const).map((category) => ({
      source: { ...source, category },
      text: `Authorized ${category}`,
    }))
    const evidence = JolliSources.evidenceOf(
      JolliSources.WORK_TOOLS[1],
      result(
        JSON.stringify({
          citationEvidence: [
            null,
            entries[0],
            { source: { ...source, category: "future" }, text: "New category" },
            {},
            entries[1],
            { source, text: null },
            entries[2],
          ],
        }),
      ),
    )
    expect(evidence).toEqual(entries.map((entry) => ({ ...entry.source, text: entry.text })))
  })

  test("reserves record places across assignments before taking more paragraphs from one assignment", () => {
    const records = Array.from({ length: 10 }, (_, assignment) =>
      Array.from({ length: assignment === 0 ? 30 : 2 }, (_, paragraph) => ({
        ...source,
        category: "record" as const,
        assignmentId: assignment + 1,
        sourceId: `assignment-record:${assignment + 1}`,
        text: `Assignment ${assignment + 1}, paragraph ${paragraph + 1}`,
      })),
    ).flat()
    const listing = JolliSources.evidenceOf(
      JolliSources.WORK_LIST_TOOL,
      result(JSON.stringify({ citationEvidence: records.map(({ text, ...source }) => ({ source, text })) })),
    )
    expect(listing).toHaveLength(JolliSources.MAX_CANDIDATES)
    expect(new Set(listing.filter((item) => item.kind === "student_work").map((item) => item.assignmentId)).size).toBe(
      10,
    )
    const content = Array.from({ length: 18 }, (_, index) => ({ ...source, text: `Content passage ${index}` }))
    const candidates = JolliSources.turnCandidates([
      ...[records.slice(0, 30), records.slice(30)].map((evidence) => ({
        type: "tool",
        tool: JolliSources.WORK_LIST_TOOL,
        state: { status: "completed", metadata: { evidence } },
      })),
      {
        type: "tool",
        tool: JolliSources.WORK_TOOLS[1],
        state: { status: "completed", metadata: { evidence: content } },
      },
    ])
    expect(candidates).toHaveLength(JolliSources.MAX_CANDIDATES)
    expect(candidates.slice(-18).map((candidate) => candidate.evidence)).toEqual(content)
    expect(candidates.slice(0, 6).map((candidate) => candidate.evidence)).toEqual([
      records[0],
      ...records
        .slice(30)
        .filter((_, index) => index % 2 === 0)
        .slice(0, 5),
    ])
  })

  test("keeps content read after a full assignment listing and fills only unused places with records", () => {
    const listing = JolliSources.evidenceOf(
      JolliSources.WORK_LIST_TOOL,
      result(
        JSON.stringify({
          citationEvidence: Array.from({ length: 12 }, (_, index) =>
            [`Lab ${index + 1}`, `report-${index + 1}.pdf`].map((text) => ({
              source: {
                kind: "student_work",
                courseId: 11,
                assignmentId: index + 1,
                category: "record",
                sourceId: `assignment-record:${index + 1}`,
                title: `Lab ${index + 1}`,
              },
              text,
            })),
          ).flat(),
        }),
      ),
    )
    const content = (["submission", "reflection", "feedback"] as const).map((category) => ({
      ...source,
      category,
      text: `The ${category} content used in the answer.`,
    }))
    const material = { kind: "material" as const, materialId: "80", title: "Handbook", text: "Course evidence." }
    const candidates = JolliSources.turnCandidates([
      {
        type: "tool",
        tool: JolliSources.WORK_LIST_TOOL,
        state: { status: "completed", metadata: { evidence: listing } },
      },
      {
        type: "tool",
        tool: JolliSources.WORK_TOOLS[1],
        state: { status: "completed", metadata: { evidence: content } },
      },
      { type: "tool", tool: READ, state: { status: "completed", metadata: { evidence: [material] } } },
    ])
    expect(candidates).toHaveLength(JolliSources.MAX_CANDIDATES)
    expect(candidates.slice(-4).map((candidate) => candidate.evidence)).toEqual([...content, material])
    expect(candidates.map((candidate) => candidate.ref)).toEqual(
      Array.from({ length: JolliSources.MAX_CANDIDATES }, (_, index) => `s${index + 1}`),
    )
    expect(JolliSources.selectedSources(["s21"], candidates)).toEqual([{ ...source, category: "submission" }])
  })

  test("preserves content and web budgets when assignment records arrive first", () => {
    const records = Array.from({ length: 30 }, (_, index) => ({
      ...source,
      category: "record" as const,
      sourceId: `assignment-record:${index + 1}`,
      text: `Record ${index + 1}`,
    }))
    const materials = Array.from({ length: 30 }, (_, index) => ({
      kind: "material" as const,
      materialId: String(index + 1),
      title: `Handbook ${index + 1}`,
      text: `Course evidence ${index + 1}.`,
    }))
    const web = Array.from({ length: 30 }, (_, index) => ({
      type: "tool",
      tool: "webfetch",
      state: {
        status: "completed",
        input: { url: `https://example.test/${index + 1}` },
        output: `Web evidence ${index + 1}.`,
      },
    }))
    const listing = {
      type: "tool",
      tool: JolliSources.WORK_LIST_TOOL,
      state: { status: "completed", metadata: { evidence: records } },
    }
    const reading = { type: "tool", tool: READ, state: { status: "completed", metadata: { evidence: materials } } }
    const candidates = JolliSources.turnCandidates([listing, reading, ...web, listing])
    expect(candidates).toHaveLength(JolliSources.MAX_CANDIDATES)
    expect(candidates.filter((candidate) => candidate.evidence.kind === "material")).toHaveLength(12)
    expect(candidates.filter((candidate) => candidate.evidence.kind === "web")).toHaveLength(12)
    expect(candidates.some((candidate) => candidate.evidence.kind === "student_work")).toBe(false)
    expect(
      JolliSources.turnCandidates([listing, reading]).every((candidate) => candidate.evidence.kind === "material"),
    ).toBe(true)
    expect(JolliSources.turnCandidates([listing])).toHaveLength(JolliSources.MAX_CANDIDATES)
  })

  test("carries work evidence through the same selection and both renderers' projection", () => {
    const evidence = JolliSources.evidenceOf(
      JolliSources.WORK_TOOLS[1],
      result(
        `Untrusted content follows.\n${JSON.stringify({ citationEvidence: [{ source, text: "I need better evidence." }] })}`,
      ),
    )
    expect(evidence).toEqual([{ ...source, text: "I need better evidence." }])
    const candidates = JolliSources.turnCandidates([
      { type: "tool", tool: JolliSources.WORK_TOOLS[1], state: { status: "completed", metadata: { evidence } } },
    ])
    const selected = JolliSources.selectedSources(["s1", "invented", "s1"], candidates)
    expect(selected).toEqual([source])
    expect(JolliSources.turnSources([{ type: "text", metadata: { answerSources: selected } }])).toEqual({
      materials: [],
      web: [],
      work: [source],
    })
  })

  test("excludes content citations from listings, failed calls, invalid identities and unsafe links", () => {
    const envelope = JSON.stringify({ citationEvidence: [{ source, text: "Evidence" }] })
    expect(JolliSources.evidenceOf(JolliSources.WORK_LIST_TOOL, result(envelope))).toEqual([])
    expect(JolliSources.evidenceOf(JolliSources.WORK_TOOLS[0], result(envelope, true))).toEqual([])
    for (const invalid of [
      { ...source, taskId: -1 },
      { ...source, url: "javascript:alert(1)" },
      { ...source, sourceId: "" },
    ]) {
      expect(
        JolliSources.evidenceOf(
          JolliSources.WORK_TOOLS[0],
          result(JSON.stringify({ citationEvidence: [{ source: invalid, text: "Evidence" }] })),
        ),
      ).toEqual([])
      expect(JolliSources.answerSourcesFromMetadata({ answerSources: [invalid] })).toEqual([])
    }
  })
})
