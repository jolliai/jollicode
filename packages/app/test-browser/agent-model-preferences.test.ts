import { afterEach, describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import type { AsyncStorage } from "@solid-primitives/storage"
import type { Platform } from "@/context/platform"
import { ServerConnection } from "@/context/server"
import { createAgentModelPreferences } from "@/jolli/agent-model-preferences"
import { account, ensureCatalog, resetCatalog, setCatalog } from "@/jolli/catalog"
import { groupChatAssistantId, groupChatModel } from "@/jolli/group-chat-composer"
import { parseModelKey } from "@/jolli/model-grant"
import { ServerScope } from "@/utils/server-scope"

function platform(): Platform {
  return {
    platform: "web",
    openExternal: () => undefined,
    restart: async () => undefined,
    notify: async () => undefined,
  }
}

afterEach(resetCatalog)

/** Everything stored apart from one key, to show a write touched nothing else. */
function storageWithout(key: string) {
  return Object.fromEntries(
    Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index) ?? "")
      .filter((name) => name !== key)
      .map((name) => [name, localStorage.getItem(name)]),
  )
}

describe("group chat agent model preferences", () => {
  test("shares consecutive picks across mounted group chats and reloads from storage", () => {
    const input = { platform: platform(), server: () => ServerScope.local, account: () => "shared-student" }
    const group = createAgentModelPreferences(input)
    const other = createAgentModelPreferences(input)
    const assistant = groupChatAssistantId("school:science:7", 21)
    group.set(assistant, "jolli/sol")
    other.set("school:science:22", "jolli/luna")
    expect(parseModelKey(other.get("school:science:21"))).toEqual({ providerID: "jolli", modelID: "sol" })
    expect(group.get("school:science:22")).toBe("jolli/luna")

    const reloaded = createAgentModelPreferences({ ...input, platform: platform() })
    expect(reloaded.get(assistant)).toBe("jolli/sol")
    expect(reloaded.get("school:science:22")).toBe("jolli/luna")
  })

  test("isolates accounts, organizations and servers and restores the returning account", () => {
    const [identity, setIdentity] = createStore<{ account?: string; server: ServerScope }>({
      account: "student-a",
      server: ServerScope.local,
    })
    const preferences = createAgentModelPreferences({
      platform: platform(),
      server: () => identity.server,
      account: () => identity.account,
    })
    preferences.set("school:science:21", "jolli/sol")
    expect(preferences.get("school:arts:21")).toBeUndefined()
    setIdentity("account", "student-b")
    expect(preferences.get("school:science:21")).toBeUndefined()
    preferences.set("school:science:21", "jolli/luna")
    setIdentity("account", undefined)
    preferences.set("school:science:21", "jolli/ignored")
    expect(preferences.get("school:science:21")).toBeUndefined()
    setIdentity("account", "student-a")
    expect(preferences.get("school:science:21")).toBe("jolli/sol")
    setIdentity(
      "server",
      ServerScope.fromServerKey(ServerConnection.key({ type: "http", http: { url: "https://remote.example" } })),
    )
    expect(preferences.get("school:science:21")).toBeUndefined()
    setIdentity("server", ServerScope.local)
    expect(preferences.get("school:science:21")).toBe("jolli/sol")
  })

  test("falls back within the current grant without replacing the stored personal choice", () => {
    const preferences = createAgentModelPreferences({
      platform: platform(),
      server: () => ServerScope.local,
      account: () => "restricted-student",
    })
    preferences.set("21", "jolli/removed")
    const model = groupChatModel(
      {
        models: [
          { id: "sol", name: "Sol" },
          { id: "removed", name: "Removed" },
        ],
        assistants: [{ id: 21, modelId: "sol", allowedModelIds: ["sol"] }],
      },
      21,
      parseModelKey(preferences.get("21"))?.modelID,
    )
    expect(model.selected).toBe("sol")
    expect(preferences.get("21")).toBe("jolli/removed")
  })

  test("retains only the three most recently used accounts and prunes their persisted data", () => {
    const [identity, setIdentity] = createStore({ account: "recent-a" })
    const input = { platform: platform(), server: () => ServerScope.local, account: () => identity.account }
    const preferences = createAgentModelPreferences(input)
    preferences.set("21", "jolli/a")
    setIdentity("account", "recent-b")
    preferences.set("21", "jolli/b")
    setIdentity("account", "recent-c")
    preferences.set("21", "jolli/c")
    setIdentity("account", "recent-a")
    preferences.activate()
    setIdentity("account", "recent-d")
    preferences.set("21", "jolli/d")

    const reloaded = createAgentModelPreferences({ ...input, platform: platform() })
    expect(reloaded.get("21")).toBe("jolli/d")
    setIdentity("account", "recent-b")
    expect(reloaded.get("21")).toBeUndefined()
    setIdentity("account", "recent-c")
    expect(reloaded.get("21")).toBe("jolli/c")
    setIdentity("account", "recent-a")
    expect(reloaded.get("21")).toBe("jolli/a")
    expect(localStorage.getItem("jollicode.global.dat:jolli-group-chat-model-preferences")).not.toContain("recent-b")
  })

  test("merges early desktop picks after hydration without moving them to a switched account", async () => {
    const hydration = Promise.withResolvers<string | null>()
    const values = new Map<string, string>()
    const storage: AsyncStorage = {
      getItem: () => hydration.promise,
      setItem: async (key, value) => {
        values.set(key, value)
      },
      removeItem: async (key) => {
        values.delete(key)
      },
      clear: async () => {
        values.clear()
      },
      key: async () => null,
      getLength: async () => values.size,
      length: Promise.resolve(0),
    }
    const [identity, setIdentity] = createStore({ account: "async-student" })
    const preferences = createAgentModelPreferences({
      platform: {
        ...platform(),
        platform: "desktop",
        storage: () => storage,
        openDirectoryPickerDialog: async () => null,
      },
      server: () => ServerScope.local,
      account: () => identity.account,
    })
    expect(preferences.ready()).toBe(false)
    preferences.set("21", "jolli/sol")
    setIdentity("account", "other-student")
    hydration.resolve(
      JSON.stringify({
        accounts: [{ id: JSON.stringify([ServerScope.local, "async-student"]), models: { "22": "jolli/luna" } }],
      }),
    )
    await preferences.ready.promise
    expect(preferences.get("21")).toBeUndefined()
    setIdentity("account", "async-student")
    expect(preferences.get("21")).toBe("jolli/sol")
    expect(preferences.get("22")).toBe("jolli/luna")
    expect(values.size).toBe(1)
  })

  test("keeps group chat picks in a slot that local sessions never read or write", () => {
    const shared = "jollicode.global.dat:jolli-agent-model-preferences"
    const own = "jollicode.global.dat:jolli-group-chat-model-preferences"
    const id = JSON.stringify([ServerScope.local, "slot-student"])
    // The slot both kinds of chat once shared, holding a pick a local session made for this assistant.
    const local = JSON.stringify({ accounts: [{ id, models: { "school:science:21": "jolli/local-pick" } }] })
    localStorage.setItem(shared, local)
    const before = storageWithout(own)
    const preferences = createAgentModelPreferences({
      platform: platform(),
      server: () => ServerScope.local,
      account: () => "slot-student",
    })
    expect(preferences.get("school:science:21")).toBeUndefined()

    preferences.set("school:science:21", "jolli/group-pick")
    expect(preferences.get("school:science:21")).toBe("jolli/group-pick")
    expect(localStorage.getItem(own)).toContain("jolli/group-pick")
    expect(storageWithout(own)).toEqual(before)
    expect(localStorage.getItem(shared)).toBe(local)
    localStorage.removeItem(shared)
  })

  test("takes account identity from each catalog response and clears it on sign-out", async () => {
    const catalog = { status: "ok" as const, courses: [], assistants: [], modelTiers: {}, account: "catalog-student" }
    setCatalog(catalog)
    expect(account()).toBe("catalog-student")
    resetCatalog()
    expect(account()).toBeUndefined()
    await ensureCatalog("offline-account", async () => ({ ...catalog, status: "unreachable" }))
    expect(account()).toBe("catalog-student")
    setCatalog({ ...catalog, account: undefined })
    expect(account()).toBeUndefined()
  })
})
