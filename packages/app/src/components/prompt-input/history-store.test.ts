import { describe, expect, test } from "bun:test"
import { createSignal } from "solid-js"
import type { Prompt } from "@/context/prompt"
import { MAX_HISTORY_SCOPES, normalizePromptHistoryEntry, promptHistoryScope, sessionHistoryScope } from "./history"
import { createPromptInputHistory } from "./history-store"

const text = (value: string): Prompt => [{ type: "text", content: value, start: 0, end: value.length }]

const contents = (entries: ReturnType<ReturnType<typeof createPromptInputHistory>["entries"]>) =>
  entries.map((entry) => {
    const part = normalizePromptHistoryEntry(entry).prompt[0]
    return part?.type === "text" ? part.content : ""
  })

describe("prompt-input history store", () => {
  test("history stays inside the chat it was typed in", () => {
    const [sessionID, setSessionID] = createSignal("a")
    const history = createPromptInputHistory(() => sessionHistoryScope(sessionID()))

    history.add(text("asked in a"), "normal", [])

    setSessionID("b")
    expect(contents(history.entries("normal"))).toEqual([])

    history.add(text("asked in b"), "normal", [])
    expect(contents(history.entries("normal"))).toEqual(["asked in b"])

    setSessionID("a")
    expect(contents(history.entries("normal"))).toEqual(["asked in a"])
  })

  test("shell history is scoped separately from prompt history", () => {
    const [sessionID, setSessionID] = createSignal("a")
    const history = createPromptInputHistory(() => sessionHistoryScope(sessionID()))

    history.add(text("git status"), "shell", [])
    expect(contents(history.entries("shell"))).toEqual(["git status"])
    expect(contents(history.entries("normal"))).toEqual([])

    setSessionID("b")
    expect(contents(history.entries("shell"))).toEqual([])
  })

  test("the first prompt follows the session its submit created", () => {
    const [sessionID, setSessionID] = createSignal<string | undefined>(undefined)
    const history = createPromptInputHistory(() => promptHistoryScope(sessionID(), "/repo"))

    history.add(text("first prompt"), "normal", [])
    history.promote(promptHistoryScope(undefined, "/repo"), sessionHistoryScope("ses_1"))

    setSessionID("ses_1")
    expect(contents(history.entries("normal"))).toEqual(["first prompt"])

    // The next new chat in the same directory starts empty instead of replaying that prompt.
    setSessionID(undefined)
    expect(contents(history.entries("normal"))).toEqual([])
  })

  test("discarding a chat's history leaves nothing for the next one to replay", () => {
    const [sessionID, setSessionID] = createSignal<string | undefined>(undefined)
    const history = createPromptInputHistory(() => promptHistoryScope(sessionID(), "/repo"))

    history.add(text("never sent"), "normal", [])
    history.add(text("git status"), "shell", [])
    expect(contents(history.entries("normal"))).toEqual(["never sent"])

    history.discard(promptHistoryScope(undefined, "/repo"))
    expect(contents(history.entries("normal"))).toEqual([])
    expect(contents(history.entries("shell"))).toEqual([])

    // A session opened afterwards is unaffected by the discard.
    setSessionID("ses_1")
    history.add(text("sent"), "normal", [])
    expect(contents(history.entries("normal"))).toEqual(["sent"])
  })

  /**
   * ⚠ THIS HAS TO RUN THROUGH THE STORE, NOT THE PURE HELPER. `touchScope` records recency as key
   * order, but `reconcile` merges key by key and never reorders — the same assertion against
   * `prependScopedHistoryEntry` alone passes while the store evicts by creation order instead.
   */
  test("the chat used most recently survives the scope cap, whenever it was created", () => {
    const [sessionID, setSessionID] = createSignal("c1")
    const history = createPromptInputHistory(() => sessionHistoryScope(sessionID()))

    for (let index = 1; index <= MAX_HISTORY_SCOPES; index++) {
      setSessionID(`c${index}`)
      history.add(text(`in c${index}`), "normal", [])
    }

    // c1 was created first but is used last, so the next eviction must fall on c2.
    setSessionID("c1")
    history.add(text("c1 again"), "normal", [])

    setSessionID(`c${MAX_HISTORY_SCOPES + 1}`)
    history.add(text("one chat too many"), "normal", [])

    setSessionID("c1")
    expect(contents(history.entries("normal"))).toEqual(["c1 again", "in c1"])
    setSessionID("c2")
    expect(contents(history.entries("normal"))).toEqual([])
  })

  test("a history built without a scope reads back what it was asked to write", () => {
    // Stories and fixtures cannot name a chat. A scoped `target` must not split such a history
    // into a bucket that is written but never read.
    const history = createPromptInputHistory()

    history.add(text("typed in a story"), "normal", [], sessionHistoryScope("ses_1"))
    expect(contents(history.entries("normal"))).toEqual(["typed in a story"])

    // Lifecycle calls carry scopes it never used; they must not wipe what it does hold.
    history.promote(sessionHistoryScope("ses_1"), sessionHistoryScope("ses_2"))
    history.discard(sessionHistoryScope("ses_1"))
    expect(contents(history.entries("normal"))).toEqual(["typed in a story"])
  })
})
