import { describe, expect, test } from "bun:test"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageID } from "../../src/session/schema"

function userMessage(id: MessageID, parts: Array<Record<string, unknown>>) {
  return { info: { id, role: "user" }, parts } as unknown as SessionV1.WithParts
}

describe("SessionPrompt.continuesTurn", () => {
  test("recognises the message auto-compaction writes to carry on with the turn", () => {
    const id = MessageID.ascending()
    const messages = [
      userMessage(id, [
        {
          type: "text",
          synthetic: true,
          text: "Continue if you have next steps.",
          metadata: { compaction_continue: true },
        },
      ]),
    ]
    expect(SessionPrompt.continuesTurn(messages, id)).toBe(true)
  })

  test("takes a message the student wrote, or one with the marker but not synthetic, as a turn of its own", () => {
    const typed = MessageID.ascending()
    const forged = MessageID.ascending()
    const messages = [
      userMessage(typed, [{ type: "text", text: "continue" }]),
      userMessage(forged, [{ type: "text", text: "continue", metadata: { compaction_continue: true } }]),
    ]
    expect(SessionPrompt.continuesTurn(messages, typed)).toBe(false)
    expect(SessionPrompt.continuesTurn(messages, forged)).toBe(false)
    expect(SessionPrompt.continuesTurn(messages, MessageID.ascending())).toBe(false)
  })
})
