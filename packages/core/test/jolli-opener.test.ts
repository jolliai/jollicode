import { describe, expect, test } from "bun:test"
import { openedOnGateway, openerTextOf } from "../src/jolli/opener"

const session = (metadata?: Record<string, unknown>) => ({ id: "ses_a", metadata })

describe("openerTextOf", () => {
  test("shows the opener of the session it was written for", () => {
    expect(openerTextOf(session({ jolliOpener: { sessionID: "ses_a", text: " Hi Maya. " } }))).toBe("Hi Maya.")
  })

  /** ⚠ A FORK OR A CHILD CARRIES A COPY UNDER ITS PARENT'S ID, AND ITS MODEL NEVER SAID IT. */
  test("hides an opener copied from another session", () => {
    expect(openerTextOf(session({ jolliOpener: { sessionID: "ses_parent", text: "Hi Maya." } }))).toBeUndefined()
  })

  test("shows nothing for no opener, a malformed one, or a blank one", () => {
    expect(openerTextOf(session())).toBeUndefined()
    expect(openerTextOf(session({ jolliOpener: "Hi" }))).toBeUndefined()
    expect(openerTextOf(session({ jolliOpener: { sessionID: "ses_a", text: 3 } }))).toBeUndefined()
    expect(openerTextOf(session({ jolliOpener: { sessionID: "ses_a", text: "  " } }))).toBeUndefined()
    expect(openerTextOf(session({ jolliOpener: { sessionID: "ses_a" } }))).toBeUndefined()
    expect(openerTextOf(undefined)).toBeUndefined()
  })
})

describe("openedOnGateway", () => {
  /** ⚠ A START THAT GOT NO OPENER STILL BOUND THE CONVERSATION ON THE GATEWAY. */
  test("a session started without an opener still counts as opened", () => {
    expect(openedOnGateway(session({ jolliOpener: { sessionID: "ses_a" } }))).toBe(true)
    expect(openedOnGateway(session({ jolliOpener: { sessionID: "ses_a", text: "Hi." } }))).toBe(true)
  })

  test("a copy carried by a fork, or no record at all, does not", () => {
    expect(openedOnGateway(session({ jolliOpener: { sessionID: "ses_parent" } }))).toBe(false)
    expect(openedOnGateway(session())).toBe(false)
    expect(openedOnGateway(undefined)).toBe(false)
  })
})
