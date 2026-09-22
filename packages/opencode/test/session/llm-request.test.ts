import { describe, expect, test } from "bun:test"
import { Brand } from "@opencode-ai/core/brand"
import { providerIdFor, SUPPORTED_PROTOCOLS } from "@opencode-ai/core/jolli/gateway-config"
import { jolliCodingAgentHeaders } from "@/session/llm/request"
import { MessageID, SessionID } from "@/session/schema"

describe("jolli coding-agent request headers", () => {
  test("binds every supported Jolli provider request to the Jollicode session", () => {
    const sessionID = SessionID.descending()
    const turnID = MessageID.ascending()

    for (const providerID of SUPPORTED_PROTOCOLS.map(providerIdFor)) {
      expect(
        jolliCodingAgentHeaders({
          providerID,
          sessionID,
          turnID,
          clientAttemptID: "attempt-1",
          stepIndex: 0,
          courseID: "7",
          courseAssistantID: "8",
        }),
      ).toEqual({
        "x-jolli-conversation-id": sessionID,
        "x-jolli-turn-id": turnID,
        "x-jolli-attempt-id": "attempt-1",
        "x-jolli-request-id": "attempt-1:0",
        "x-jolli-step-index": "0",
        "x-jolli-space-id": "7",
        "x-jolli-assistant-id": "8",
      })
    }
  })

  test("keeps the conversation id stable across provider steps and distinct across sessions", () => {
    const firstSessionID = SessionID.descending()
    const secondSessionID = SessionID.descending()
    const base = {
      providerID: providerIdFor("openai"),
      turnID: MessageID.ascending(),
      clientAttemptID: "attempt-1",
    }

    const firstStep = jolliCodingAgentHeaders({ ...base, sessionID: firstSessionID, stepIndex: 0 })
    const secondStep = jolliCodingAgentHeaders({ ...base, sessionID: firstSessionID, stepIndex: 1 })
    const otherSession = jolliCodingAgentHeaders({ ...base, sessionID: secondSessionID, stepIndex: 0 })

    expect(firstSessionID).not.toBe(secondSessionID)
    expect(firstStep["x-jolli-conversation-id"]).toBe(firstSessionID)
    expect(secondStep["x-jolli-conversation-id"]).toBe(firstSessionID)
    expect(otherSession["x-jolli-conversation-id"]).toBe(secondSessionID)
    expect(firstStep["x-jolli-request-id"]).toBe("attempt-1:0")
    expect(secondStep["x-jolli-request-id"]).toBe("attempt-1:1")
  })

  test("does not mark auxiliary or non-Jolli provider calls as coding-agent turns", () => {
    expect(
      jolliCodingAgentHeaders({
        providerID: providerIdFor("openai"),
        sessionID: SessionID.descending(),
      }),
    ).toEqual({})
    expect(
      jolliCodingAgentHeaders({
        providerID: "openai",
        sessionID: SessionID.descending(),
        turnID: MessageID.ascending(),
        clientAttemptID: "attempt-1",
        stepIndex: 0,
      }),
    ).toEqual({})
    expect(
      jolliCodingAgentHeaders({
        providerID: `${Brand.short}-unsupported`,
        sessionID: SessionID.descending(),
        turnID: MessageID.ascending(),
        clientAttemptID: "attempt-1",
        stepIndex: 0,
      }),
    ).toEqual({})
  })
})
