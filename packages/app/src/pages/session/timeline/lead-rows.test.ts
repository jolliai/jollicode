import { describe, expect, test } from "bun:test"
import { constructLeadRows } from "./lead-rows"
import { TimelineRow } from "./timeline-row"

const keys = (rows: ReturnType<typeof constructLeadRows>) => rows.map(TimelineRow.key)
const opener = { sessionID: "ses_a", text: "Hi Maya, thanks for coming in." }
const metadata = { jolliOpener: opener }

/**
 * The rows above the first turn. The opener is display-only and belongs to one session: a fork or a
 * child carries a copy of the metadata but no opener on the gateway, and the history has to be
 * complete before "the top" means the top of the chat.
 */
describe("constructLeadRows", () => {
  test("puts the brief first and the opener after it", () => {
    const rows = constructLeadRows({
      sessionID: "ses_a",
      brief: "Interview prep",
      metadata,
      historyComplete: true,
    })
    expect(keys(rows)).toEqual(["brief", "opener:ses_a"])
    expect(rows[0]).toEqual(new TimelineRow.Brief({ text: "Interview prep" }))
    expect(rows[1]).toEqual(new TimelineRow.Opener({ sessionID: "ses_a", text: opener.text }))
  })

  test("shows no opener in a session it was not written for", () => {
    const rows = constructLeadRows({ sessionID: "ses_fork", brief: "", metadata, historyComplete: true })
    expect(rows).toEqual([])
  })

  test("shows nothing while older history is still to load", () => {
    const rows = constructLeadRows({ sessionID: "ses_a", brief: "Brief", metadata, historyComplete: false })
    expect(rows).toEqual([])
  })

  test("drops a blank brief and a malformed opener", () => {
    expect(
      constructLeadRows({ sessionID: "ses_a", brief: "  \n ", metadata: { jolliOpener: "Hi" }, historyComplete: true }),
    ).toEqual([])
    expect(
      constructLeadRows({
        sessionID: "ses_a",
        brief: undefined,
        metadata: { jolliOpener: { sessionID: "ses_a", text: "   " } },
        historyComplete: true,
      }),
    ).toEqual([])
  })

  test("is nothing without a session", () => {
    expect(constructLeadRows({ sessionID: undefined, brief: "Brief", metadata, historyComplete: true })).toEqual([])
  })
})
