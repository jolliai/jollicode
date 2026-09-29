import { describe, expect, test } from "bun:test"
import type { Jolli } from "@opencode-ai/schema/jolli"
import { QueryClient, QueryObserver } from "@tanstack/solid-query"
import { applyShareWrite, followFullReads, readersQuery, shareQuery } from "./use-session-share"

type Server = Parameters<typeof shareQuery>[0]

const ORIGIN = "http://127.0.0.1:4096"
const GRACE: Jolli.SessionReader = {
  kind: "person",
  userId: 2,
  name: "Grace Hopper",
  detail: "grace@jolli.ai",
  access: "view",
}
const ROSTER: Jolli.ShareMember[] = [{ userId: 2, name: "Grace Hopper", detail: "grace@jolli.ai", kind: "staff" }]

/** What the sidecar answers a write or the readers read with: the readers, no roster. */
function readersOnly(readers: Jolli.SessionReader[], status: Jolli.ShareStatus = "ok"): Jolli.SessionShare {
  return { status, courseId: 7, courseCode: "CS 310", readers, members: [], classSize: 0, roster: "unavailable" }
}

function fullRead(readers: Jolli.SessionReader[]): Jolli.SessionShare {
  return { ...readersOnly(readers), members: ROSTER, classSize: 30, roster: "ok" }
}

/**
 * THE SIDECAR, AS BOTH READS SEE IT. Each read is served with who could read the session at the
 * moment it was asked, and its answer is held until `release` — so a test can land a read after a
 * write that committed after it was served.
 */
function sidecar() {
  const state = { readers: [GRACE], status: "ok" as Jolli.ShareStatus }
  const held: Array<() => void> = []
  const serve = (data: Jolli.SessionShare) =>
    new Promise<{ data: Jolli.SessionShare }>((resolve) => held.push(() => resolve({ data })))
  const readers = () => (state.status === "ok" ? state.readers : [])
  const server = {
    url: ORIGIN,
    client: {
      jolli: {
        share: () => serve(state.status === "ok" ? fullRead(readers()) : readersOnly([], state.status)),
        shareReaders: () => serve(readersOnly(readers(), state.status)),
      },
    },
  } as unknown as Server
  return {
    server,
    state,
    release: async () => {
      await Bun.sleep(0)
      held.splice(0).forEach((resolve) => resolve())
      await Bun.sleep(0)
    },
  }
}

describe("the header button's readers", () => {
  test("a readers read that cannot reach Jolli keeps the last answer that said something", async () => {
    const jolli = sidecar()
    const queryClient = new QueryClient()
    const readers = readersQuery(jolli.server, "ses_1")

    const first = queryClient.fetchQuery(readers)
    await jolli.release()
    await first
    jolli.state.status = "unreachable"
    const second = queryClient.fetchQuery({ ...readers, staleTime: 0 }).then(
      () => "answered",
      (error: Error) => error.message,
    )
    await jolli.release()

    expect(await second).toBe("Jolli readers read answered unreachable")
    expect(queryClient.getQueryData<Jolli.SessionShare>(readers.queryKey)).toEqual(readersOnly([GRACE]))
  })

  test("a full read that lands reaches the button's entry, without the roster", async () => {
    const jolli = sidecar()
    const queryClient = new QueryClient()
    const stop = followFullReads(queryClient, ORIGIN, "ses_1")

    const read = queryClient.fetchQuery(shareQuery(jolli.server, "ses_1"))
    await jolli.release()
    await read

    expect(queryClient.getQueryData<Jolli.SessionShare>(readersQuery(jolli.server, "ses_1").queryKey)).toEqual(
      readersOnly([GRACE]),
    )
    stop()
  })

  test("a full read that says nothing leaves the button's entry alone", async () => {
    const jolli = sidecar()
    const queryClient = new QueryClient()
    const readers = readersQuery(jolli.server, "ses_1").queryKey
    queryClient.setQueryData(readers, readersOnly([GRACE]))
    const stop = followFullReads(queryClient, ORIGIN, "ses_1")

    jolli.state.status = "unreachable"
    const read = queryClient.fetchQuery(shareQuery(jolli.server, "ses_1"))
    await jolli.release()
    await read

    expect(queryClient.getQueryData<Jolli.SessionShare>(readers)).toEqual(readersOnly([GRACE]))
    stop()
  })
})

describe("a share write", () => {
  test("lands in both entries, keeping the full read's roster; a refused one changes neither", async () => {
    const jolli = sidecar()
    const queryClient = new QueryClient()
    const full = shareQuery(jolli.server, "ses_1").queryKey
    const readers = readersQuery(jolli.server, "ses_1").queryKey
    queryClient.setQueryData(full, fullRead([GRACE]))
    queryClient.setQueryData(readers, readersOnly([GRACE]))

    await applyShareWrite(queryClient, ORIGIN, "ses_1", readersOnly([]))
    expect(queryClient.getQueryData<Jolli.SessionShare>(full)).toEqual(fullRead([]))
    expect(queryClient.getQueryData<Jolli.SessionShare>(readers)).toEqual(readersOnly([]))

    await applyShareWrite(queryClient, ORIGIN, "ses_1", {
      ...readersOnly([], "refused"),
      refusal: "subject_not_in_course",
    })
    expect(queryClient.getQueryData<Jolli.SessionShare>(full)).toEqual(fullRead([]))
    expect(queryClient.getQueryData<Jolli.SessionShare>(readers)).toEqual(readersOnly([]))
  })

  /**
   * ⚠ THE COACHING GATE ASKS, THE STUDENT WITHDRAWS A GRANT, AND THE GATE'S READ LANDS LAST. Served
   * before the withdrawal, it would put Grace back in the panel and the button, and tell the gate
   * staff can still read. With the panel open and with it already closed: an entry with no observer
   * left must be asked again all the same.
   */
  test.each([["open"], ["closed"]])("a full read sent before it cannot undo it, panel %s", async (panel) => {
    const jolli = sidecar()
    const queryClient = new QueryClient()
    const stop = followFullReads(queryClient, ORIGIN, "ses_1")
    const full = shareQuery(jolli.server, "ses_1")
    queryClient.setQueryData(full.queryKey, fullRead([GRACE]))
    const unsubscribe =
      panel === "open"
        ? new QueryObserver(queryClient, { ...full, staleTime: Number.POSITIVE_INFINITY }).subscribe(() => {})
        : () => {}

    const gate = queryClient.fetchQuery({ ...full, staleTime: 0 })
    jolli.state.readers = []
    await applyShareWrite(queryClient, ORIGIN, "ses_1", readersOnly([]))
    await jolli.release()

    expect((await gate).readers).toEqual([])
    expect(queryClient.getQueryData<Jolli.SessionShare>(full.queryKey)?.readers).toEqual([])
    expect(queryClient.getQueryData<Jolli.SessionShare>(readersQuery(jolli.server, "ses_1").queryKey)).toEqual(
      readersOnly([]),
    )
    unsubscribe()
    stop()
  })

  test("a readers read sent before it cannot undo it", async () => {
    const jolli = sidecar()
    const queryClient = new QueryClient()
    const readers = readersQuery(jolli.server, "ses_1")

    const read = queryClient.fetchQuery(readers).catch(() => undefined)
    jolli.state.readers = []
    await applyShareWrite(queryClient, ORIGIN, "ses_1", readersOnly([]))
    await jolli.release()
    await read

    expect(queryClient.getQueryData<Jolli.SessionShare>(readers.queryKey)).toEqual(readersOnly([]))
  })
})
