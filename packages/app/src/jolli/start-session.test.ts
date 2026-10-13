import { describe, expect, test } from "bun:test"
import { START_REFUSAL } from "@opencode-ai/core/jolli/refusal"
import { dict } from "@/i18n/en"
import { startErrorKey } from "./start-session"

/** A refused Start says what the shared English table for Start says, through the dictionary. */
describe("startErrorKey", () => {
  test("words each refusal the way the shared Start table does", () => {
    for (const code of Object.keys(START_REFUSAL) as (keyof typeof START_REFUSAL)[]) {
      expect(dict[startErrorKey(code)]).toBe(START_REFUSAL[code])
    }
  })

  test("says try again for an unknown code, no code, or no answer", () => {
    expect(startErrorKey("something_new")).toBe("prompt.jolli.start.failed")
    expect(startErrorKey(undefined)).toBe("prompt.jolli.start.failed")
    expect(dict["prompt.jolli.start.failed"]).toBe("Couldn't start the chat. Try again.")
  })
})
