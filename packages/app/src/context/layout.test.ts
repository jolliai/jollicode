import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createSessionKeyReader, ensureSessionKey, pruneSessionKeys } from "./layout-helpers"
import { migrateSidebar } from "./layout-migration"
import { currentRoute } from "./layout"
import { Jolli } from "@opencode-ai/schema/jolli"
import { groupChatHref } from "@/utils/session-route"
import type { ServerConnection } from "./server"

describe("layout session-key helpers", () => {
  test("couples touch and scroll seed in order", () => {
    const calls: string[] = []
    const result = ensureSessionKey(
      "dir/a",
      (key) => calls.push(`touch:${key}`),
      (key) => calls.push(`seed:${key}`),
    )

    expect(result).toBe("dir/a")
    expect(calls).toEqual(["touch:dir/a", "seed:dir/a"])
  })

  test("reads dynamic accessor keys lazily", () => {
    const seen: string[] = []

    createRoot((dispose) => {
      const [key, setKey] = createSignal("dir/one")
      const read = createSessionKeyReader(key, (value) => seen.push(value))

      expect(read()).toBe("dir/one")
      setKey("dir/two")
      expect(read()).toBe("dir/two")

      dispose()
    })

    expect(seen).toEqual(["dir/one", "dir/two"])
  })
})

describe("pruneSessionKeys", () => {
  test("keeps active key and drops lowest-used keys", () => {
    const drop = pruneSessionKeys({
      keep: "k4",
      max: 3,
      used: new Map([
        ["k1", 1],
        ["k2", 2],
        ["k3", 3],
        ["k4", 4],
      ]),
      view: ["k1", "k2", "k4"],
      tabs: ["k1", "k3", "k4"],
    })

    expect(drop).toEqual(["k1"])
    expect(drop.includes("k4")).toBe(false)
  })

  test("does not prune without keep key", () => {
    const drop = pruneSessionKeys({
      keep: undefined,
      max: 1,
      used: new Map([
        ["k1", 1],
        ["k2", 2],
      ]),
      view: ["k1"],
      tabs: ["k2"],
    })

    expect(drop).toEqual([])
  })
})

describe("migrateSidebar", () => {
  test("opens the sidebar once for an install that predates it", () => {
    const next = migrateSidebar({ opened: false, width: 344 })

    expect(next).toEqual({ width: 344, opened: true, railMigrated: true })
  })

  /**
   * ⚠ THE ONE THAT MATTERS. If the latch were read off `opened`, this case would reopen the sidebar
   * on every launch and the close button would look broken.
   */
  test("leaves a migrated install that was deliberately closed alone", () => {
    const stored = { opened: false, width: 344, railMigrated: true }
    const next = migrateSidebar(stored)

    expect(next).toBe(stored)
  })

  test("returns the same reference when there is nothing to do", () => {
    const stored = { opened: true, width: 300, railMigrated: true, workspaces: {} }

    expect(migrateSidebar(stored)).toBe(stored)
  })

  test("carries a boolean workspaces flag into the per-directory map, and still migrates the rail", () => {
    expect(migrateSidebar({ opened: false, workspaces: true })).toEqual({
      opened: true,
      railMigrated: true,
      workspaces: {},
      workspacesDefault: true,
    })
  })

  test("passes through a missing or non-record slice so the store defaults apply", () => {
    expect(migrateSidebar(undefined)).toBeUndefined()
    expect(migrateSidebar(null)).toBeNull()
    expect(migrateSidebar("nonsense")).toBe("nonsense")
    expect(migrateSidebar([1, 2])).toEqual([1, 2])
  })
})

describe("currentRoute for group chats", () => {
  const server = "local\nhttp://localhost:4096" as ServerConnection.Key

  test("reads the server and the encoded org-scoped chat id", () => {
    const chatId = Jolli.GroupChatID.make("tenant:org:42")

    expect(currentRoute(groupChatHref(server, chatId), "")).toEqual({ type: "groupChat", chatId, server })
  })

  test("a malformed chat id is no route rather than an error", () => {
    const prefix = groupChatHref(server, Jolli.GroupChatID.make("tenant:org:42")).replace(/[^/]+$/, "")

    expect(currentRoute(`${prefix}%E0%A4%A`, "")).toEqual({ type: "home" })
    expect(currentRoute(`${prefix}not-scoped`, "")).toEqual({ type: "home" })
  })
})
