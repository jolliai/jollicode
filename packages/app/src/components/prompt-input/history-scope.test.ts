import { describe, expect, test } from "bun:test"
import { createSignal } from "solid-js"
import type { Prompt } from "@/context/prompt"
import { ServerScope } from "@/utils/server-scope"
import { createPromptHistoryScope } from "./history-scope"
import type { PromptInputHistory } from "./history-store"

const text = (value: string): Prompt => [{ type: "text", content: value, start: 0, end: value.length }]

function recorder() {
  const calls: string[] = []
  const history: PromptInputHistory = {
    entries: () => [],
    add: (_prompt, _mode, _comments, scope) => calls.push(`add ${scope}`),
    promote: (from, to) => calls.push(`promote ${from} > ${to}`),
    discard: (scope) => calls.push(`discard ${scope}`),
  }
  return { calls, history }
}

/** Only `scope()` is under test through this one — the history is a stub nothing reads back. */
const bind = (sessionID: () => string | undefined, directory = "/repo", draftID?: string) =>
  createPromptHistoryScope({
    history: recorder().history,
    sessionID,
    serverScope: () => ServerScope.local,
    directory: () => directory,
    draftID: () => draftID,
  })

describe("prompt history scope", () => {
  test("one chat gets one bucket however its directory is spelled", () => {
    const windows = bind(() => undefined, "C:\\repo\\")
    const posix = bind(() => undefined, "C:/repo")
    expect(windows.scope()).toBe(posix.scope())

    const other = bind(() => undefined, "C:/other")
    expect(other.scope()).not.toBe(posix.scope())
  })

  test("two new chats open on one folder do not share a bucket", () => {
    const first = bind(() => undefined, "/repo", "draft-1")
    const second = bind(() => undefined, "/repo", "draft-2")
    expect(first.scope()).not.toBe(second.scope())

    // A composer with no draft of its own still falls back to the folder.
    const folder = bind(() => undefined, "/repo")
    expect(folder.scope()).not.toBe(first.scope())
    expect(folder.scope()).toBe(bind(() => undefined, "/repo").scope())

    // The draft is the identity, so the same draft reached from either spelling of the folder path
    // is still one bucket.
    expect(bind(() => undefined, "C:\\repo\\", "draft-1").scope()).toBe(
      bind(() => undefined, "C:/repo", "draft-1").scope(),
    )
  })

  test("a live session and a sessionless composer address different buckets", () => {
    const live = bind(() => "ses_1")
    const draft = bind(() => undefined)
    expect(live.scope()).not.toBe(draft.scope())
    expect(bind(() => "ses_2").scope()).not.toBe(live.scope())
  })

  test("a submit from a sessionless chat hands its entry to the session it creates", () => {
    const { calls, history } = recorder()
    const [sessionID, setSessionID] = createSignal<string | undefined>(undefined)
    const scope = createPromptHistoryScope({
      history,
      sessionID,
      serverScope: () => ServerScope.local,
      directory: () => "/repo",
    })

    const pending = scope.scope()
    history.add(text("first"), "normal", [], scope.submitted())
    setSessionID("ses_1")
    scope.promote("ses_1")

    expect(calls).toEqual([`add ${pending}`, `promote ${pending} > ${scope.scope()}`])
  })

  test("a submit inside a live session has nothing to promote", () => {
    const { calls, history } = recorder()
    const scope = createPromptHistoryScope({
      history,
      sessionID: () => "ses_1",
      serverScope: () => ServerScope.local,
      directory: () => "/repo",
    })

    history.add(text("followup"), "normal", [], scope.submitted())
    scope.promote("ses_1")

    expect(calls).toEqual([`add ${scope.scope()}`])
  })

  test("a submit that creates no session drops its entry instead of leaving it behind", () => {
    const { calls, history } = recorder()
    const scope = createPromptHistoryScope({
      history,
      sessionID: () => undefined,
      serverScope: () => ServerScope.local,
      directory: () => "/repo",
    })

    const pending = scope.scope()
    history.add(text("never sent"), "normal", [], scope.submitted())
    scope.discard()
    // Nothing is outstanding any more, so a later promote cannot resurrect it.
    scope.promote("ses_1")

    expect(calls).toEqual([`add ${pending}`, `discard ${pending}`])
  })
})
