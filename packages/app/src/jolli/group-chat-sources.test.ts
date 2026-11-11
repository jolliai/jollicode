import { describe, expect, test } from "bun:test"
import { Jolli } from "@opencode-ai/schema/jolli"
import {
  groupChatSourceGroups,
  groupChatSourcesByMessage,
  groupChatSourceUrl,
  type GroupChatSource,
} from "./group-chat-sources"

const material = { kind: "material", id: 1525, title: "Course outline", studentAccess: "download" } as const
const chat: Jolli.GroupChat = {
  id: Jolli.GroupChatID.make("tenant1:default:chat-1"),
  title: "Course group",
  viewerId: 1,
  access: "participant",
  processing: false,
  group: { participants: [], formerPeople: [], aliases: [] },
  messages: [],
  courseId: "tenant1:default:32",
  webBaseUrl: "https://jolli.example/t/tenant1/o/default",
}
const message = (id: number, turnId: number, payload?: Jolli.ChatMessage["payload"]): Jolli.ChatMessage => ({
  kind: "message",
  id,
  seq: id,
  turnId,
  role: "assistant",
  content: "Course overview",
  timestamp: "2026-11-10T13:31:00Z",
  payload,
})

describe("group chat served references", () => {
  test("renders served sources once on the final answer of each independent turn", () => {
    const messages = [
      message(1, 10, { answerSources: [material] }),
      message(2, 20, { answerSources: [{ ...material, id: 1526 }] }),
      message(3, 10),
    ]
    const sources = groupChatSourcesByMessage(messages)
    expect([...sources.keys()]).toEqual([3, 2])
    expect(sources.get(3)?.[0].title).toBe("Course outline")
  })

  test("does not invent citations from prose, uploads or empty attribution", () => {
    expect(
      groupChatSourcesByMessage([
        {
          ...message(1, 1, { attachments: [{ attachmentId: 2, filename: "Outline.pdf" }] }),
          content: "Read Course outline.",
        },
        message(2, 2, { answerSources: [material] }),
        message(3, 2, { answerSources: [] }),
      ]).size,
    ).toBe(0)
  })

  test("ignores peer-supplied attribution, incomplete answers and failed final answers", () => {
    expect(
      groupChatSourcesByMessage([
        { ...message(1, 1, { answerSources: [material] }), role: "user" },
        { ...message(2, 2, { answerSources: [material] }), incomplete: true },
        message(3, 3, { answerSources: [material] }),
        { ...message(4, 3), content: "[ERROR] Generation failed" },
      ]).size,
    ).toBe(0)
  })

  test("keeps valid references beside malformed or unsupported entries", () => {
    const sources = groupChatSourcesByMessage([
      message(1, 1, {
        answerSources: [
          null,
          { ...material, id: -1 },
          { ...material, title: " " },
          { kind: "connector", title: "Private file" },
          material,
        ],
      }),
    ])
    expect(sources.get(1)).toEqual([material])
  })

  test("groups a document once and keeps distinct excerpts without duplicates", () => {
    const heading = { ...material, locator: { kind: "heading", path: ["Overview"] } } as const
    const ordinal = { ...material, locator: { kind: "ordinal", index: 4 } } as const
    const groups = groupChatSourceGroups([material, heading, heading, ordinal])
    expect(groups).toHaveLength(1)
    expect(groups[0].source).toEqual({ ...material, locator: undefined })
    expect(groups[0].excerpts).toEqual([heading, ordinal])
  })

  test("groups assignment records with their worksheet without merging a material of the same id", () => {
    const record = {
      kind: "student_work",
      courseId: 32,
      assignmentId: 8,
      category: "record",
      sourceId: "assignment:8",
      title: "Linked list assignment",
    } as const
    const worksheet = { ...material, id: 8, assignment: { courseId: 32 } }
    const groups = groupChatSourceGroups([worksheet, record, { ...material, id: 8 }])
    expect(groups.map((group) => group.key)).toEqual(["assignment:32:8", "material:8"])
    expect(groups[0].excerpts).toEqual([record])
  })

  test("preserves tenant scope and heading paths when opening a reading", () => {
    const source = { ...material, locator: { kind: "heading", path: ["Week 1", "A & B"] } } as const
    const url = groupChatSourceUrl(source, chat, false)!
    expect(url.pathname).toBe("/t/tenant1/o/default/learn/32/materials/1525")
    expect(url.searchParams.getAll("heading")).toEqual(["Week 1", "A & B"])
    expect(groupChatSourceUrl({ ...material, locator: { kind: "page", page: 4, lastPage: 6 } }, chat, true)?.href).toBe(
      "https://jolli.example/t/tenant1/o/default/courses/32/materials/1525?page=4",
    )
  })

  test("keeps withheld materials locked for students and openable for staff", () => {
    const withheld = { ...material, studentAccess: "hidden" }
    expect(groupChatSourceUrl(withheld, chat, false)).toBeUndefined()
    expect(groupChatSourceUrl(withheld, chat, true)?.pathname).toContain("/courses/32/materials/1525")
    const group = groupChatSourceGroups([material, { ...withheld, locator: { kind: "ordinal", index: 2 } }])[0]
    expect(groupChatSourceUrl(group.source, chat, false)).toBeUndefined()
  })

  test("blocks unavailable materials and opens an authorized successor without the old locator", () => {
    const unavailable = { ...material, unavailable: true, locator: { kind: "page", page: 4 } } as const
    expect(groupChatSourceUrl(unavailable, chat, true)).toBeUndefined()
    expect(groupChatSourceUrl({ ...unavailable, replacedBy: 1600 }, chat, false)?.href).toBe(
      "https://jolli.example/t/tenant1/o/default/learn/32/materials/1600",
    )
  })

  test("an unavailable duplicate locks its document and all of its excerpts", () => {
    const excerpt = { ...material, locator: { kind: "ordinal", index: 2 } } as const
    const group = groupChatSourceGroups([excerpt, { ...excerpt, unavailable: true }])[0]
    expect(group.excerpts).toHaveLength(1)
    expect(groupChatSourceUrl(group.source, chat, true)).toBeUndefined()
    const locked = group.source.kind === "material" ? { ...group.source, locator: excerpt.locator } : group.source
    expect(groupChatSourceUrl(locked, chat, false)).toBeUndefined()
  })

  test("uses only safe served web addresses and never executable URLs", () => {
    for (const url of ["javascript:alert(1)", "data:text/html,test", "file:///tmp/test", "not a URL"]) {
      expect(groupChatSourceUrl({ kind: "web", title: "Unsafe", url }, chat, false)).toBeUndefined()
      expect(groupChatSourceUrl(material, { ...chat, webBaseUrl: url }, false)).toBeUndefined()
    }
    const source = {
      ...material,
      sourceUrl: "https://course.example/outline",
      locator: { kind: "heading", path: ["A-B, C"] },
    } as const
    expect(groupChatSourceUrl(source, chat, false)?.href).toBe("https://course.example/outline#:~:text=A%2DB%2C%20C")
  })

  test("opens assignment sources through the reader's course route and task anchor", () => {
    const record: GroupChatSource = {
      kind: "student_work",
      courseId: 32,
      assignmentId: 8,
      taskId: 9,
      category: "record",
      sourceId: "task:9",
      title: "Task 1",
    }
    expect(groupChatSourceUrl(record, chat, false)?.href).toBe(
      "https://jolli.example/t/tenant1/o/default/learn/32/assignments/8#task-9",
    )
    expect(groupChatSourceUrl({ ...material, id: 8, assignment: { courseId: 32 } }, chat, true)?.pathname).toBe(
      "/t/tenant1/o/default/courses/32/assignments/8/preview",
    )
  })
})
