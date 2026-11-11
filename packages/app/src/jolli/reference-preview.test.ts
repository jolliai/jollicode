import { describe, expect, test } from "bun:test"
import JSZip from "jszip"
import { utils, write } from "xlsx"
import { guardExternalLinks } from "./external-link"
import { prepareDocxPackage } from "./reference-docx-package"
import { READER_DOCX_ENTRIES, READER_DOCX_INFLATED_BYTES } from "./reference-reader-limits"
import { materialViewerKind } from "./reference-viewer-kind"
import {
  scopedReferencePreview,
  referenceCourseTarget,
  ReferenceAssignment,
  safeReferenceUrl,
  type ReferencePreview,
} from "./reference-preview"
import { Schema } from "effect"
import { Jolli } from "@opencode-ai/schema/jolli"
import { assignmentReferenceStatus } from "./reference-assignment-status"
import { referenceMindMap, referenceMindMapLayout } from "./reference-mindmap"
import { decodeMaterialText } from "./reference-material-encoding"
import { csvDelimiter, parseCsv } from "./parse-reference-csv"
import { openExcelWorkbook, readExcelSheet, excelSheetPreview, excelVisibleSheetNames } from "./reference-excel-data"

describe("web chat reference viewer behavior", () => {
  test("the same material id in two organizations stays in distinct preview tabs", () => {
    const item: ReferencePreview = {
      key: "material:7",
      title: "Lecture",
      reference: { kind: "material", materialId: 7 },
    }
    const first = scopedReferencePreview({ kind: "course", courseId: "school:first:32" }, item)
    const second = scopedReferencePreview({ kind: "course", courseId: "school:second:32" }, item)
    expect(first.key).not.toBe(second.key)
    expect(scopedReferencePreview({ kind: "course", courseId: "school:second:32" }, first)).toBe(first)
  })
  test("uses every web chat material viewer and leaves unsupported formats download-only", () => {
    expect(
      [
        "application/pdf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.ms-excel",
        "image/svg+xml",
        "text/markdown",
        "text/csv",
        "text/plain",
        "application/vnd.ms-powerpoint",
        "text/html",
      ].map((type) => materialViewerKind(type)),
    ).toEqual(["pdf", "docx", "excel", "image", "markdown", "csv", "text", "none", "none"])
    expect(materialViewerKind("text/html", { map: true, webPage: true })).toBe("mindmap")
    expect(materialViewerKind("text/html", { webPage: true })).toBe("webpage")
  })
  test("CSV viewing preserves quoted newlines and detects Excel's delimiter directive", () => {
    expect(parseCsv('sep=;\r\nName;Note\r\nAlice;"line one\nline two"\r\n')).toEqual([
      ["Name", "Note"],
      ["Alice", "line one\nline two"],
    ])
  })
  test("CSV viewing reads leniently and finds the separator outside quotes", () => {
    expect(parseCsv('a,"b ""q"" c",d\r\ne\rf\n')).toEqual([["a", 'b "q" c', "d"], ["e"], ["f"]])
    // A quote inside an unquoted field is a character; text after a closing quote joins the field.
    expect(parseCsv('x"y,"z"tail,"open\nrest')).toEqual([['x"y', "ztail", "open\nrest"]])
    expect(parseCsv("")).toEqual([])
    expect(parseCsv("a,b\n\n")).toEqual([["a", "b"], [""]])
    expect(csvDelimiter('"a;b;c",d;e\n1;2')).toEqual({ delimiter: ";", start: 0 })
    expect(csvDelimiter("a\tb\n1\t2")).toEqual({ delimiter: "\t", start: 0 })
    expect(csvDelimiter("a,b;c")).toEqual({ delimiter: ",", start: 0 })
    expect(csvDelimiter("one column")).toEqual({ delimiter: ",", start: 0 })
  })
  test("workbook previews keep sheets and formatted cell text without rendering formula HTML", async () => {
    const workbook = utils.book_new()
    utils.book_append_sheet(
      workbook,
      utils.aoa_to_sheet([
        ["Name", "Result"],
        ["<img src=x>", 7],
      ]),
      "Scores",
    )
    utils.book_append_sheet(workbook, utils.aoa_to_sheet([["Other"]]), "Notes")
    const bytes: ArrayBuffer = write(workbook, { bookType: "xlsx", type: "array" })
    const opened = await openExcelWorkbook(bytes)
    expect(excelVisibleSheetNames(opened.directory)).toEqual(["Scores", "Notes"])
    const preview = excelSheetPreview(readExcelSheet(opened, "Scores"), "Scores")
    expect(preview.rows[1].cells).toEqual(["<img src=x>", "7"])
  })
  test("a workbook whose every sheet is hidden lists no sheet to show", async () => {
    const workbook = utils.book_new()
    utils.book_append_sheet(workbook, utils.aoa_to_sheet([["Data"]]), "Data")
    workbook.Workbook = { Sheets: [{ Hidden: 1 }] }
    const bytes: ArrayBuffer = write(workbook, { bookType: "xlsx", type: "array" })
    const opened = await openExcelWorkbook(bytes)
    expect(excelVisibleSheetNames(opened.directory)).toEqual([])
  })
  test("preview destinations cannot execute an imported URL", () => {
    expect(safeReferenceUrl("https://example.com/reading")).toBe("https://example.com/reading")
    for (const url of ["javascript:alert(1)", "data:text/html,test", "file:///tmp/private"])
      expect(safeReferenceUrl(url)).toBeUndefined()
  })
  test("nested course plan references retain their organization when opened from a group", () => {
    expect(referenceCourseTarget({ kind: "group", chatID: Jolli.GroupChatID.make("school:other:chat-1") }, 7)).toEqual({
      kind: "course",
      courseId: "school:other:7",
    })
  })
  test("readers distinguish the cited submission from a replacement snapshot", () => {
    const assignment = Schema.decodeUnknownSync(ReferenceAssignment)({
      id: 1,
      courseId: 32,
      title: "Assignment",
      description: "",
      worksheet: "",
      dueAt: null,
      parts: [
        {
          id: 4,
          kind: "files",
          name: "Report",
          cardKey: "report",
          position: 0,
          submission: { submissionId: 10, files: [{ id: 7, filename: "Report.pdf", sizeBytes: 50, status: "ready" }] },
        },
      ],
    })
    expect(assignmentReferenceStatus(assignment, "hand-in-file:7", 4)).toBe("current")
    expect(assignmentReferenceStatus(assignment, "hand-in-file:6", 4)).toBe("changed")
    expect(assignmentReferenceStatus(assignment, "older-server-id", 4)).toBe("unknown")
  })
  test("mind map previews retain floating topics and respect folded branches", () => {
    const map = referenceMindMap({
      root: {
        oid: "root",
        text: "Course",
        children: [{ oid: "branch", text: "Week 1", children: [{ oid: "leaf", text: "Exercise", children: [] }] }],
      },
      floating: [{ oid: "note", text: "Notes", children: [] }],
    })
    expect(referenceMindMapLayout(map.roots, new Set()).nodes.map((node) => node.topic.text)).toEqual([
      "Course",
      "Week 1",
      "Exercise",
      "Notes",
    ])
    expect(referenceMindMapLayout(map.roots, new Set(["branch"])).nodes.map((node) => node.topic.text)).toEqual([
      "Course",
      "Week 1",
      "Notes",
    ])
  })
  test("mind map topics show only the images the server signed as parts of the map", () => {
    const map = referenceMindMap({
      root: {
        oid: "root",
        text: "Course",
        image: { materialId: 9, url: "https://storage.example/signed.png" },
        children: [
          { oid: "remote", text: "Remote", image: { url: "https://tracker.example/pixel.png" }, children: [] },
        ],
      },
    })
    expect(map.roots[0].image).toBe("https://storage.example/signed.png")
    expect(map.roots[0].children[0].image).toBeUndefined()
  })
  test("text previews decode UTF-16 storage bytes with the web reader's decoder", () => {
    expect(decodeMaterialText(new Uint8Array([255, 254, 72, 0, 105, 0]), { truncated: false })).toBe("Hi")
  })
})

describe("links inside previewed content", () => {
  function linkFixture(href: string) {
    const root = document.createElement("div")
    const anchor = document.createElement("a")
    anchor.setAttribute("href", href)
    anchor.target = "_blank"
    const label = document.createElement("span")
    label.textContent = "Reading"
    anchor.append(label)
    root.append(anchor)
    document.body.append(root)
    const opened: string[] = []
    const fragments: string[] = []
    const release = guardExternalLinks(root, {
      open: (url) => opened.push(url),
      fragment: (id) => fragments.push(id),
    })
    const press = (type: "click" | "auxclick", init: MouseEventInit = {}) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init })
      label.dispatchEvent(event)
      return event.defaultPrevented
    }
    return {
      opened,
      fragments,
      press,
      cleanup() {
        release()
        root.remove()
      },
    }
  }

  test("a click, a modified click and a middle click all wait for the confirmation instead of opening", () => {
    const link = linkFixture("https://example.com/reading?week=2")
    expect(link.press("click")).toBe(true)
    expect(link.press("click", { ctrlKey: true })).toBe(true)
    expect(link.press("click", { shiftKey: true })).toBe(true)
    expect(link.press("auxclick", { button: 1 })).toBe(true)
    expect(link.opened).toEqual(Array(4).fill("https://example.com/reading?week=2"))
    link.cleanup()
  })

  test("a right click is left to the context menu, and nothing is asked once the guard is released", () => {
    const link = linkFixture("https://example.com/reading")
    expect(link.press("auxclick", { button: 2 })).toBe(false)
    expect(link.opened).toEqual([])
    link.cleanup()
    expect(link.press("click")).toBe(false)
    expect(link.opened).toEqual([])
  })

  test("addresses that are not web pages never open, and in-document links stay in the document", () => {
    const script = linkFixture("javascript:alert(1)")
    expect(script.press("click")).toBe(true)
    expect(script.opened).toEqual([])
    script.cleanup()
    const file = linkFixture("file:///etc/passwd")
    expect(file.press("auxclick", { button: 1 })).toBe(true)
    expect(file.opened).toEqual([])
    file.cleanup()
    const heading = linkFixture("#week-2")
    expect(heading.press("click")).toBe(true)
    expect(heading.fragments).toEqual(["week-2"])
    expect(heading.opened).toEqual([])
    heading.cleanup()
  })

  test("a link the parent window made is still caught inside a frame whose window has classes of its own", () => {
    // docx-preview makes a Word document's nodes with the parent's `document` and moves them into its
    // frame, where they keep the parent window's prototypes: the frame's `Element` and `MouseEvent` are
    // stood in for here by constructors nothing in this test is an instance of.
    const frame = document.implementation.createHTMLDocument("frame")
    const foreign = { Element: function () {}, MouseEvent: function () {} }
    Object.defineProperty(frame, "defaultView", { value: foreign })
    const anchor = document.createElement("a")
    anchor.setAttribute("href", "https://example.com/handout")
    const label = document.createElement("span")
    label.textContent = "Handout"
    anchor.append(label)
    frame.body.append(anchor)
    const opened: string[] = []
    const release = guardExternalLinks(frame, { open: (url) => opened.push(url) })
    const press = (type: "click" | "auxclick", init: MouseEventInit = {}) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init })
      label.dispatchEvent(event)
      return event.defaultPrevented
    }
    expect(press("click")).toBe(true)
    expect(press("auxclick", { button: 1 })).toBe(true)
    expect(press("auxclick", { button: 2 })).toBe(false)
    expect(opened).toEqual(["https://example.com/handout", "https://example.com/handout"])
    release()
  })
})

describe("Word documents are bounded before they are unzipped or rendered", () => {
  async function docx(files: Record<string, string | Uint8Array>, compression: "DEFLATE" | "STORE" = "DEFLATE") {
    const zip = new JSZip()
    for (const [name, content] of Object.entries(files)) zip.file(name, content)
    return new Uint8Array(await zip.generateAsync({ type: "uint8array", compression }))
  }
  /** Rewrite one member's uncompressed size in both its headers, as a package that lies about it would. */
  function declareSize(bytes: Uint8Array<ArrayBuffer>, size: number) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    let end = bytes.byteLength - 4
    while (view.getUint32(end, true) !== 0x06054b50) end -= 1
    const central = view.getUint32(end + 16, true)
    view.setUint32(central + 24, size, true)
    view.setUint32(view.getUint32(central + 42, true) + 22, size, true)
    return bytes
  }
  async function refusal(bytes: Uint8Array<ArrayBuffer>) {
    return prepareDocxPackage(bytes).then(
      () => undefined,
      (error: unknown) => error,
    )
  }

  test("a readable document is prepared with its symbol bullets mapped", async () => {
    const prepared = await prepareDocxPackage(
      await docx({
        "word/document.xml": "<w:document/>",
        "word/numbering.xml": '<w:lvlText w:val="&#xF0B7;"/>',
      }),
    )
    expect(prepared.unsupported.size).toBe(0)
    expect(await (await JSZip.loadAsync(prepared.bytes)).file("word/numbering.xml")?.async("string")).toBe(
      '<w:lvlText w:val="•"/>',
    )
  })

  test("a member that expands past the preview's bound is refused", async () => {
    const bomb = await docx({ "word/media/fill.bin": new Uint8Array(READER_DOCX_INFLATED_BYTES + 1) })
    expect(bomb.byteLength).toBeLessThan(1024 * 1024)
    expect(await refusal(bomb)).toBeInstanceOf(Error)
  })

  test("a member that expands past the size its headers declare is stopped while inflating", async () => {
    const bomb = declareSize(await docx({ "word/document.xml": new Uint8Array(4 * 1024 * 1024) }), 1000)
    expect(await refusal(bomb)).toBeInstanceOf(Error)
  })

  test("a package with more parts than a document has is refused before any part is opened", async () => {
    const files = Object.fromEntries(
      Array.from({ length: READER_DOCX_ENTRIES + 1 }, (_, index) => [`word/media/${index}.txt`, "x"]),
    )
    expect(await refusal(await docx(files, "STORE"))).toBeInstanceOf(Error)
  })

  test("central headers past the count the end record gives are refused, since JSZip would read them", async () => {
    const bytes = await docx({ "word/document.xml": "<w:document/>", "word/media/fill.bin": "x" })
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    let end = bytes.byteLength - 4
    while (view.getUint32(end, true) !== 0x06054b50) end -= 1
    view.setUint16(end + 8, 1, true)
    view.setUint16(end + 10, 1, true)
    expect(await refusal(bytes)).toBeInstanceOf(Error)
  })
})
