import { describe, expect, test } from "bun:test"
import { JolliSources } from "../src/jolli/sources"

const SEARCH = "jolliedu_search_remote_course_materials"
const READ = "jolliedu_get_remote_material_content"

const result = (text: string, isError = false) => ({ content: [{ type: "text", text }], isError })

describe("JolliSources.materialEvidenceOf", () => {
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
})
