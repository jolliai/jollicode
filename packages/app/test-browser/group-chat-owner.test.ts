import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import type { Platform } from "@/context/platform"
import { createGroupChatOwners, unknownGroupChatOwner } from "@/jolli/group-chat-owner"

/**
 * Desktop windows sharing one storage, as the desktop app's are: one file per name, each read and written
 * asynchronously. `delay` holds every read back that long, as a slow disk would.
 */
function desktop(delay = 0) {
  const files = new Map<string, Map<string, string>>()
  const storage = (name = "default.dat") => {
    const file = files.get(name) ?? new Map<string, string>()
    files.set(name, file)
    return {
      getItem: (key: string) =>
        new Promise<string | null>((resolve) => setTimeout(() => resolve(file.get(key) ?? null), delay)),
      setItem: async (key: string, value: string) => {
        file.set(key, value)
      },
      removeItem: async (key: string) => {
        file.delete(key)
      },
    }
  }
  return {
    files,
    window: (windowID: string): Platform => ({
      platform: "desktop",
      windowID,
      storage,
      openExternal: () => undefined,
      restart: async () => undefined,
      notify: async () => undefined,
      openDirectoryPickerDialog: async () => null,
    }),
  }
}

/** A window's record; `kept` is the servers whose group chat tabs it loaded from an earlier run. */
const owners = (platform: Platform, kept?: readonly string[]) =>
  createRoot(() => createGroupChatOwners(platform, kept && Promise.resolve(kept)))

describe("whose group chats a window holds", () => {
  test("two windows keep their own record: neither reads nor overwrites the other's", async () => {
    const app = desktop()
    const first = owners(app.window("first"))
    const second = owners(app.window("second"))
    await first.held("server")
    await second.held("server")
    first.take("server", "owner-a")
    second.take("server", "owner-b")
    expect(await first.held("server")).toBe("owner-a")
    expect(await second.held("server")).toBe("owner-b")
    second.forget("server")
    expect(await second.held("server")).toBeUndefined()
    expect(await first.held("server")).toBe("owner-a")
    // Each window's record is its own file, and a window opened again reads its own back.
    expect([...app.files.keys()].filter((name) => name.startsWith("jollicode.window."))).toEqual([
      "jollicode.window.first.dat",
      "jollicode.window.second.dat",
    ])
    expect(await owners(app.window("first")).held("server")).toBe("owner-a")
    expect(await owners(app.window("second")).held("server")).toBeUndefined()
  })

  test("a record kept for one server is not lost to a change made for another before it loaded", async () => {
    const app = desktop()
    const before = owners(app.window("main"))
    await before.held("one")
    before.take("one", "owner-a")
    const slow = desktop(20)
    slow.files.set("jollicode.window.main.dat", new Map(app.files.get("jollicode.window.main.dat")))
    const reopened = owners(slow.window("main"))
    reopened.take("two", "owner-b")
    expect(await reopened.held("one")).toBe("owner-a")
    expect(await reopened.held("two")).toBe("owner-b")
  })

  test("chats kept from an earlier run with no owner recorded are an unknown owner's until a list or a reset", async () => {
    const app = desktop()
    const before = owners(app.window("main"))
    await before.held("recorded")
    before.take("recorded", "owner-a")
    const main = owners(app.window("main"), ["kept", "recorded", "reset"])
    expect(await main.held("kept")).toBe(unknownGroupChatOwner)
    expect(await main.held("recorded")).toBe("owner-a")
    // A server whose chats were all opened during this run, or none at all, holds nothing it kept.
    expect(await main.held("opened")).toBeUndefined()
    main.take("kept", "owner-b")
    expect(await main.held("kept")).toBe("owner-b")
    main.forget("reset")
    expect(await main.held("reset")).toBeUndefined()
    // A reset deletes the record: tabs the window holds at its next start were written after it, and no list
    // named their owner either.
    main.forget("kept")
    expect(await owners(app.window("main"), ["kept"]).held("kept")).toBe(unknownGroupChatOwner)
  })
})
