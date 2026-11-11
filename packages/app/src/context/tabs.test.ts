import { describe, expect, test } from "bun:test"
import { createRoot, getOwner, onCleanup } from "solid-js"
import { Jolli } from "@opencode-ai/schema/jolli"
import { createTabMemory } from "./tab-memory"
import {
  nextTabAfterClose,
  pushClosedTab,
  releasedGroupChats,
  removeClosedTabs,
  removeTabsWhere,
  takeClosedTab,
  type ClosedTab,
} from "./closed-tabs"
import type { GroupChatTab, SessionTab, Tab } from "./tabs"
import { migrateTabs } from "./tab-migration"
import type { ServerConnection } from "./server"

const server = "local\nhttp://localhost:4096" as ServerConnection.Key

function sessionTab(sessionId: string): SessionTab {
  return { type: "session", server, sessionId }
}

function groupChatTab(chatId: string): GroupChatTab {
  return { type: "groupChat", server, chatId: Jolli.GroupChatID.make(chatId) }
}

describe("tab migration", () => {
  test("drops null and malformed persisted tabs", () => {
    expect(
      migrateTabs([null, sessionTab("a"), { type: "session", server }, { type: "unknown", server }, "invalid"], server),
    ).toEqual([sessionTab("a")])
  })

  test("adds the fallback server to valid legacy tabs", () => {
    expect(migrateTabs([{ type: "session", sessionId: "a", dirBase64: "legacy" }], server)).toEqual([sessionTab("a")])
  })

  test("replaces invalid top-level persisted data", () => {
    expect(migrateTabs(null, server)).toEqual([])
    expect(migrateTabs({}, server)).toEqual([])
  })
})

describe("tab memory", () => {
  test("keeps state until its tab is removed", () => {
    createRoot((dispose) => {
      const memory = createTabMemory(getOwner())
      let disposed = 0
      const first = memory.ensure("tab", "prompt", () => {
        onCleanup(() => disposed++)
        return { value: "prompt" }
      })

      expect(memory.ensure("tab", "prompt", () => ({ value: "other" }))).toBe(first)
      expect(memory.get<typeof first>("tab", "prompt")).toBe(first)
      expect(memory.get("missing", "prompt")).toBeUndefined()
      expect(memory.ensure("other", "prompt", () => ({ value: "other" }))).not.toBe(first)

      memory.remove("tab")
      expect(disposed).toBe(1)
      expect(memory.ensure("tab", "prompt", () => ({ value: "new" }))).not.toBe(first)
      dispose()
    })
  })
})

describe("closed tab stack", () => {
  test("records session tabs with their index", () => {
    const stack = pushClosedTab([], sessionTab("a"), 2)

    expect(stack).toEqual([{ tab: sessionTab("a"), index: 2 }])
  })

  test("ignores draft tabs", () => {
    const draft: Tab = { type: "draft", draftID: "d1", server, directory: "/tmp" }

    expect(pushClosedTab([], draft, 0)).toEqual([])
  })

  test("caps the stack size", () => {
    const stack = Array.from({ length: 30 }, (_, i) => i).reduce<ClosedTab[]>(
      (acc, i) => pushClosedTab(acc, sessionTab(`s${i}`), i),
      [],
    )

    expect(stack).toHaveLength(25)
    expect(stack[0]?.tab.sessionId).toBe("s5")
    expect(stack.at(-1)?.tab.sessionId).toBe("s29")
  })

  test("pops the most recently closed tab", () => {
    const stack = [
      { tab: sessionTab("a"), index: 0 },
      { tab: sessionTab("b"), index: 1 },
    ]
    const result = takeClosedTab(stack, [])

    expect(result.entry?.tab.sessionId).toBe("b")
    expect(result.stack).toEqual([{ tab: sessionTab("a"), index: 0 }])
  })

  test("skips entries whose tab is already open", () => {
    const stack = [
      { tab: sessionTab("a"), index: 0 },
      { tab: sessionTab("b"), index: 1 },
    ]
    const result = takeClosedTab(stack, [sessionTab("b")])

    expect(result.entry?.tab.sessionId).toBe("a")
    expect(result.stack).toEqual([])
  })

  test("returns no entry when everything is open or empty", () => {
    expect(takeClosedTab([], []).entry).toBeUndefined()

    const result = takeClosedTab([{ tab: sessionTab("a"), index: 0 }], [sessionTab("a")])
    expect(result.entry).toBeUndefined()
    expect(result.stack).toEqual([])
  })

  test("purges removed sessions", () => {
    const stack = [
      { tab: sessionTab("a"), index: 0 },
      { tab: sessionTab("b"), index: 1 },
    ]

    expect(removeClosedTabs(stack, server, ["a"])).toEqual([{ tab: sessionTab("b"), index: 1 }])
  })

  test("does not navigate when a background tab closes", () => {
    const tabs = [sessionTab("a"), sessionTab("b"), sessionTab("c")]

    expect(nextTabAfterClose(tabs, 1, false)).toBeUndefined()
    expect(nextTabAfterClose(tabs, 1, true)).toEqual(sessionTab("c"))
    expect(nextTabAfterClose([sessionTab("a")], 0, true)).toBeNull()
  })
})

describe("removing group chat tabs", () => {
  const isChat = (ids: string[]) => (tab: Tab) => tab.type === "groupChat" && ids.includes(tab.chatId)
  const showing = (tab: Tab) => (item: Tab) => item === tab

  test("removes every matching tab and keeps the neighbours", () => {
    const tabs = [sessionTab("a"), groupChatTab("t:o:1"), sessionTab("b"), groupChatTab("t:o:2"), sessionTab("c")]

    expect(removeTabsWhere(tabs, isChat(["t:o:1", "t:o:2"]), () => false)).toEqual({
      tabs: [sessionTab("a"), sessionTab("b"), sessionTab("c")],
      next: undefined,
    })
  })

  test("moves from a removed active tab to the next survivor, else the one before, else home", () => {
    const active = groupChatTab("t:o:1")
    const tabs = [sessionTab("a"), active, groupChatTab("t:o:2"), sessionTab("b")]

    expect(removeTabsWhere(tabs, isChat(["t:o:1", "t:o:2"]), showing(active)).next).toEqual(sessionTab("b"))
    expect(removeTabsWhere([sessionTab("a"), active], isChat(["t:o:1"]), showing(active)).next).toEqual(sessionTab("a"))
    expect(removeTabsWhere([active], isChat(["t:o:1"]), showing(active)).next).toBeNull()
  })

  /**
   * The page and the global access listener both remove a chat that lost access, in the same tick.
   * Each removal is decided against the tabs its update sees, so the second one changes nothing.
   */
  test("a repeated removal leaves the tabs and the route alone", () => {
    const active = groupChatTab("t:o:1")
    const tabs = [sessionTab("a"), active, sessionTab("b")]
    const first = removeTabsWhere(tabs, isChat(["t:o:1"]), showing(active))
    const second = removeTabsWhere(first.tabs, isChat(["t:o:1"]), showing(active))

    expect(first).toEqual({ tabs: [sessionTab("a"), sessionTab("b")], next: sessionTab("b") })
    expect(second).toEqual({ tabs: [sessionTab("a"), sessionTab("b")], next: undefined })
  })
})

describe("closed group chat memory", () => {
  test("is released when its last entry leaves the stack", () => {
    const previous = Array.from({ length: 25 }, (_, i) => ({
      tab: i === 0 ? groupChatTab("t:o:1") : sessionTab(`s${i}`),
      index: i,
    }))
    const next = pushClosedTab<SessionTab | GroupChatTab>(previous, sessionTab("s25"), 0)

    expect(releasedGroupChats(previous, next, [])).toEqual([groupChatTab("t:o:1")])
  })

  test("is kept while a newer entry can still reopen the chat", () => {
    const previous = Array.from({ length: 25 }, (_, i) => ({
      tab: i < 2 ? groupChatTab("t:o:1") : sessionTab(`s${i}`),
      index: i,
    }))
    const next = pushClosedTab<SessionTab | GroupChatTab>(previous, sessionTab("s25"), 0)

    expect(releasedGroupChats(previous, next, [])).toEqual([])
  })

  test("is kept when the evicted chat is open again under the same key", () => {
    const previous = Array.from({ length: 25 }, (_, i) => ({
      tab: i === 0 ? groupChatTab("t:o:1") : sessionTab(`s${i}`),
      index: i,
    }))
    const next = pushClosedTab<SessionTab | GroupChatTab>(previous, sessionTab("s25"), 0)

    expect(releasedGroupChats(previous, next, [sessionTab("x"), groupChatTab("t:o:1")])).toEqual([])
  })
})
