import { describe, expect, test } from "bun:test"
import { APICallError } from "ai"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ProviderError } from "@/provider/error"

describe("provider stream errors", () => {
  test("retries provider stream errors without a code", () => {
    const messages = [
      "The model is currently at capacity due to high demand. Please try again in a few minutes, or use a higher service tier for priority processing: https://docs.x.ai/developers/advanced-api-usage/priority-processing",
      "The model is temporarily unavailable.",
    ]

    for (const message of messages)
      expect(
        ProviderError.parseStreamError({
          type: "error",
          error: { message },
        }),
      ).toEqual({
        type: "api_error",
        message,
        isRetryable: true,
        responseBody: JSON.stringify({ type: "error", error: { message } }),
      })
  })
})

describe("Jolli gateway refusals", () => {
  const parse = (providerID: string, statusCode: number, body: unknown, message = "") =>
    ProviderError.parseAPICallError({
      providerID: ProviderV2.ID.make(providerID),
      error: new APICallError({
        message,
        url: "https://acme.jolli.ai/api/llm/v1/messages",
        requestBodyValues: {},
        statusCode,
        responseHeaders: { "content-type": "application/json" },
        responseBody: JSON.stringify(body),
      }),
    })
  const refusal = (...args: Parameters<typeof parse>) => parse(...args).message

  /**
   * ⚠ THE STUDENT READS THE SENTENCE, NOT THE WIRE. Before this, a closed agent read
   * "Forbidden: This agent has closed." — or, over HTTP/2 where the status text is empty, the whole
   * JSON body.
   */
  test("words every gateway code exactly, with no status prefix and no body", () => {
    const cases = [
      [403, "assistant_not_open", "This agent isn't open yet."],
      [403, "assistant_closed", "This agent has closed. You can still read this chat."],
      [404, "assistant_not_found", "This agent is no longer available."],
      [404, "course_not_found", "This agent is no longer available."],
      [404, "session_not_found", "This chat can't continue. Start a new chat."],
      [409, "course_archived", "This course is archived."],
      [409, "session_binding_conflict", "This chat can't continue. Start a new chat."],
    ] as const
    for (const [status, code, expected] of cases) {
      expect(refusal("jolli-anthropic", status, { error: "raw", code }, "Forbidden")).toBe(expected)
      expect(refusal("jolli-openai", status, { error: "raw", code })).toBe(expected)
    }
  })

  /** ⚠ THE AI SDK MARKS EVERY 409 RETRYABLE; A REFUSAL IS A DECISION, AND RETRYING IT ONLY DELAYS IT. */
  test("a refusal is never retried, though the SDK would retry its status", () => {
    const archived = parse("jolli-anthropic", 409, { error: "raw", code: "course_archived" })
    expect(archived.type === "api_error" && archived.isRetryable).toBe(false)
    const conflict = parse("jolli-anthropic", 409, { error: "raw", code: "something_new" })
    expect(conflict.type === "api_error" && conflict.isRetryable).toBe(true)
  })

  test("an unknown code from the gateway falls through to the general wording", () => {
    expect(refusal("jolli-anthropic", 403, { error: "Nope", code: "something_new" }, "Forbidden")).toBe(
      "Forbidden: Nope",
    )
  })

  // The table is the Jolli gateway's vocabulary; another provider's `code` means something else.
  test("another provider's body is not read as a Jolli refusal", () => {
    expect(refusal("anthropic", 403, { error: "raw", code: "assistant_closed" }, "Forbidden")).toBe("Forbidden: raw")
  })
})
