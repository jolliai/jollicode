import { createEffect, createRoot, on } from "solid-js"
import { createStore } from "solid-js/store"
import { usePlatform, type Platform } from "@/context/platform"
import { useServerSDK } from "@/context/server-sdk"
import { Persist, persisted } from "@/utils/persist"
import type { ServerScope } from "@/utils/server-scope"
import { account } from "./catalog"

/**
 * Group chats' remembered model for each assistant, per account, in a slot of its own: local
 * sessions never read or write it, and it never reads theirs. A local session keeps the model saved
 * with that session, and a pick made in one must not move the other.
 */
function createPreferences(platform: Platform) {
  return createRoot(() =>
    persisted(
      Persist.global("jolli-group-chat-model-preferences"),
      createStore<{ accounts: { id: string; models: Record<string, string | undefined> }[] }>({ accounts: [] }),
      platform,
    ),
  )
}

// All mounted chats share one writer, including desktop storage's asynchronous hydration.
const stores = new WeakMap<Platform, ReturnType<typeof createPreferences>>()

export function createAgentModelPreferences(input: {
  platform: Platform
  server: () => ServerScope
  account: () => string | undefined
}) {
  const saved = stores.get(input.platform) ?? createPreferences(input.platform)
  stores.set(input.platform, saved)
  const key = () => {
    const account = input.account()
    if (!account) return undefined
    return JSON.stringify([input.server(), account])
  }
  const update = (id: string, assistantId?: string, modelId?: string) => {
    const write = () =>
      saved[1]("accounts", (accounts) => {
        const models = accounts.find((item) => item.id === id)?.models ?? {}
        return [
          { id, models: assistantId ? { ...models, [assistantId]: modelId } : models },
          ...accounts.filter((item) => item.id !== id),
        ].slice(0, 3)
      })
    // Merge after hydration so an early pick cannot erase other assistants' saved choices.
    if (saved[2] instanceof Promise && !saved[3]()) {
      void saved[2].then(write).catch(() => undefined)
      return
    }
    write()
  }
  return {
    ready: saved[3],
    activate() {
      const id = key()
      if (!id) return
      if (saved[0].accounts[0]?.id === id && saved[0].accounts.length <= 3) return
      update(id)
    },
    get(assistantId: string | undefined) {
      const id = key()
      return id && assistantId ? saved[0].accounts.find((item) => item.id === id)?.models[assistantId] : undefined
    },
    set(assistantId: string | undefined, modelId: string | undefined) {
      const id = key()
      if (!id || !assistantId) return
      update(id, assistantId, modelId)
    },
  }
}

export function useAgentModelPreferences() {
  const sdk = useServerSDK()
  const preferences = createAgentModelPreferences({ platform: usePlatform(), server: () => sdk().scope, account })
  createEffect(
    on([() => sdk().scope, account, preferences.ready], () => {
      if (preferences.ready()) preferences.activate()
    }),
  )
  return preferences
}
