import { describe, expect, test } from "bun:test"
import {
  groupChatAssistantId,
  groupChatDictation,
  groupChatModel,
  groupChatRecipient,
  groupChatSendRequest,
  groupChatTargetPrompt,
} from "./group-chat-composer"

const composer = {
  models: [
    { id: "luna", name: "GPT-6 Luna" },
    { id: "sol", name: "GPT-6 Sol" },
  ],
  assistants: [
    { id: 21, modelId: "luna", allowedModelIds: ["luna", "sol"] },
    { id: 22, modelId: "sol", allowedModelIds: ["sol"] },
    { id: 23, modelId: "missing", allowedModelIds: [] },
    { id: 24, modelId: "luna", allowedModelIds: ["missing"] },
  ],
}
const mention = (name: string) => ({
  type: "agent" as const,
  name,
  content: `@${name}`,
  start: 0,
  end: name.length + 1,
})

describe("group chat composer recipients and model grants", () => {
  test("sends ordinary messages and people mentions to the group", () => {
    expect(groupChatRecipient([])).toBeNull()
    expect(groupChatRecipient([{ type: "text", content: "Hello", start: 0, end: 5 }])).toBeNull()
    expect(groupChatRecipient([mention("person:7")])).toBeNull()
    expect(groupChatRecipient([mention("all")])).toBeNull()
  })

  test("only explicit agent mentions select an assistant, using the last one in the draft", () => {
    expect(groupChatRecipient([mention("agent:22"), mention("person:7")])).toBe(22)
    expect(groupChatRecipient([mention("agent:22"), mention("agent:21")])).toBe(21)
    expect(groupChatRecipient([])).toBeNull()
  })

  test("keeps the toolbar recipient after clearing a sent draft and for the next plain message", () => {
    expect(groupChatRecipient([], 21)).toBe(21)
    expect(groupChatRecipient([{ type: "text", content: "Next question", start: 0, end: 13 }], 21)).toBe(21)
    expect(groupChatRecipient([mention("agent:22")], 21)).toBe(22)
  })

  test("people and everyone mentions override the remembered recipient for only that draft", () => {
    expect(groupChatRecipient([mention("person:7")], 21)).toBeNull()
    expect(groupChatRecipient([mention("all")], 21)).toBeNull()
    expect(groupChatRecipient([mention("all"), mention("agent:22")], 21)).toBe(22)
    expect(groupChatRecipient([], 21)).toBe(21)
  })

  test("uses the same organization-scoped assistant address as direct chats", () => {
    expect(groupChatAssistantId("7", 21)).toBe("21")
    expect(groupChatAssistantId("school:science:7", 21)).toBe("school:science:21")
    expect(groupChatAssistantId("school:arts:7", 21)).toBe("school:arts:21")
    expect(groupChatAssistantId("7", null)).toBeUndefined()
    expect(groupChatAssistantId("invalid", 21)).toBeUndefined()
  })

  test("switching the toolbar target removes agent mentions and reindexes the retained draft", () => {
    expect(
      groupChatTargetPrompt([
        mention("agent:21"),
        { type: "text", content: "Hello ", start: 9, end: 15 },
        mention("person:7"),
      ]),
    ).toEqual([
      { type: "text", content: "Hello ", start: 0, end: 6 },
      { ...mention("person:7"), start: 6, end: 15 },
    ])
  })

  test("a newly picked agent replaces earlier agents even when inserted before them", () => {
    const prompt = groupChatTargetPrompt(
      [
        mention("agent:22"),
        { type: "text", content: "Hello ", start: 9, end: 15 },
        mention("agent:21"),
        mention("person:7"),
      ],
      22,
    )
    expect(prompt).toEqual([
      mention("agent:22"),
      { type: "text", content: "Hello ", start: 9, end: 15 },
      { ...mention("person:7"), start: 15, end: 24 },
    ])
    expect(groupChatRecipient(prompt, 21)).toBe(22)
    expect(groupChatRecipient([], 22)).toBe(22)
  })

  test("keeps a personal choice only while the actual assistant grants it", () => {
    expect(groupChatModel(composer, 21, "luna").selected).toBe("luna")
    expect(groupChatModel(composer, 22, "luna")).toEqual({ options: [composer.models[1]], selected: "sol" })
    expect(groupChatModel(composer, 21, "removed").selected).toBe("luna")
  })

  test("falls back within an unrestricted grant and never opens an unavailable restricted grant", () => {
    expect(groupChatModel(composer, 23).options).toHaveLength(2)
    expect(groupChatModel(composer, 23).selected).toBe("luna")
    expect(groupChatModel(composer, 24)).toEqual({ options: [], selected: undefined })
  })

  test("never resolves an assistant model for human messages, missing choices or an unavailable catalogue", () => {
    expect(groupChatModel(composer, null, "luna").selected).toBeUndefined()
    expect(groupChatModel(composer, 99, "luna").selected).toBeUndefined()
    expect(groupChatModel(undefined, 21, "luna").selected).toBeUndefined()
  })

  test("selects no model when the model list did not load, so the ask goes with the server default", () => {
    expect(groupChatModel({ models: [], assistants: composer.assistants }, 21, "luna")).toEqual({
      options: [],
      selected: undefined,
    })
    expect(groupChatModel({ models: composer.models, assistants: [] }, 21, "luna")).toEqual({
      options: [],
      selected: undefined,
    })
  })
})

describe("group chat dictation", () => {
  const empty = { type: "text" as const, content: "", start: 0, end: 0 }

  test("dictating into an empty draft adds the words with no leading space", () => {
    expect(groupChatDictation([empty], "hello there")).toEqual([
      empty,
      { type: "text", content: "hello there", start: 0, end: 11 },
    ])
    expect(groupChatDictation([], "hello")).toEqual([{ type: "text", content: "hello", start: 0, end: 5 }])
  })

  test("a space separates dictation from written words, but is never doubled", () => {
    const written = { type: "text" as const, content: "Hi", start: 0, end: 2 }
    expect(groupChatDictation([written], "again").at(-1)).toEqual({ type: "text", content: " again", start: 2, end: 8 })
    const spaced = { type: "text" as const, content: "Hi ", start: 0, end: 3 }
    expect(groupChatDictation([spaced], "again").at(-1)).toEqual({ type: "text", content: "again", start: 3, end: 8 })
    expect(groupChatDictation([written], " again").at(-1)).toEqual({
      type: "text",
      content: " again",
      start: 2,
      end: 8,
    })
  })

  test("offsets continue after mentions, and an empty transcript leaves the draft as it was", () => {
    const prompt = [mention("person:7")]
    expect(groupChatDictation(prompt, "look").at(-1)).toEqual({ type: "text", content: " look", start: 9, end: 14 })
    expect(groupChatDictation(prompt, "")).toBe(prompt)
  })
})

describe("retrying a send whose answer was lost", () => {
  const prompt = [{ type: "text" as const, content: "Can someone check step 3?", start: 0, end: 25 }]
  const body = (clientRequestId: string, assistant?: number) => ({
    message: "Can someone check step 3?",
    clientRequestId,
    ...(assistant === undefined ? {} : { mentionedAssistantId: assistant, modelId: "luna" }),
    mentionedUserIds: [],
    mentionsAll: false,
  })

  test("an identical retry goes under the lost send's request id, asking an agent or sending to the group", () => {
    const asked = groupChatSendRequest(undefined, prompt, body("first", 21), false)
    expect(groupChatSendRequest(asked, prompt, body("second", 21), false).body.clientRequestId).toBe("first")
    const grouped = groupChatSendRequest(undefined, prompt, body("first"), true)
    expect(groupChatSendRequest(grouped, prompt, body("second"), true).body.clientRequestId).toBe("first")
  })

  test("sending to the group instead of asking an agent is another message, under its own id", () => {
    const asked = groupChatSendRequest(undefined, prompt, body("first", 21), false)
    expect(groupChatSendRequest(asked, prompt, body("second"), true).body.clientRequestId).toBe("second")
    // With no agent to ask the two bodies match, yet the choice still makes them two sends.
    const plain = groupChatSendRequest(undefined, prompt, body("first"), false)
    expect(groupChatSendRequest(plain, prompt, body("second"), true).body.clientRequestId).toBe("second")
  })

  test("a changed draft is a new message", () => {
    const asked = groupChatSendRequest(undefined, prompt, body("first", 21), false)
    const edited = [{ ...prompt[0], content: "Can someone check step 4?" }]
    expect(groupChatSendRequest(asked, edited, body("second", 21), false).body.clientRequestId).toBe("second")
  })
})
