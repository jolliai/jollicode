import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import type { Jolli } from "@opencode-ai/schema/jolli"
import { ServerConnection } from "@/context/server"
import { createGroupChatFeatures } from "./group-chat-features"
import { groupChatDrops, resetGroupChatWindow } from "./group-chat-state"

/** A read whose answer the test gives when it chooses. */
function pending() {
  const reads: Array<(answer: Jolli.GroupChatAnswer) => void> = []
  return {
    read: () => new Promise<Jolli.GroupChatAnswer>((resolve) => reads.push(resolve)),
    answer: (index: number, answer: Jolli.GroupChatAnswer) => reads[index]?.(answer),
  }
}

const offered: Jolli.GroupChatAnswer = { status: "ok", resource: { input: true, readAloud: true } }

describe("a group chat page's features", () => {
  test("a features read answering signed out drops what the window holds of the server's chats", async () => {
    const key = ServerConnection.Key.make("features-signed-out")
    const removed: string[] = []
    const tabs = {
      removeGroupChats: (server: ServerConnection.Key) => {
        removed.push(server)
      },
      groupChatOwners: { held: async () => undefined, take: () => undefined, forget: () => undefined },
    }
    const drops = groupChatDrops(key)
    const features = createRoot(() =>
      createGroupChatFeatures({
        read: async () => ({ status: "signed-out", httpStatus: 401 }),
        generation: () => 0,
        signOut: () => resetGroupChatWindow(tabs, key),
      }),
    )
    await features.load()
    expect(removed).toEqual([key])
    expect(groupChatDrops(key)).toBe(drops + 1)
    expect(features.capabilities).toEqual({ input: false, readAloud: false })
    expect(features.status).toEqual({ loading: false, loaded: false })
  })

  test("an answer that arrives after the page dropped what it holds writes nothing", async () => {
    const reads = pending()
    const page = { generation: 0 }
    const features = createRoot(() =>
      createGroupChatFeatures({ read: reads.read, generation: () => page.generation, signOut: () => undefined }),
    )
    const late = features.load()
    // The page drops (another person, a lost sign-in or a chat this reader left) while the read is out.
    page.generation += 1
    reads.answer(0, offered)
    await late
    expect(features.capabilities).toEqual({ input: false, readAloud: false })
    expect(features.status.loaded).toBe(false)
    // A read made after the drop is taken.
    const next = features.load()
    reads.answer(1, offered)
    await next
    expect(features.capabilities).toEqual({ input: true, readAloud: true })
    expect(features.status).toEqual({ loading: false, loaded: true })
  })

  test("a read that a later one overtook does not end the later read's loading", async () => {
    const reads = pending()
    const page = { generation: 0 }
    const features = createRoot(() =>
      createGroupChatFeatures({ read: reads.read, generation: () => page.generation, signOut: () => undefined }),
    )
    const first = features.load()
    page.generation += 1
    const second = features.load()
    reads.answer(0, offered)
    await first
    expect(features.status.loading).toBe(true)
    reads.answer(1, offered)
    await second
    expect(features.status).toEqual({ loading: false, loaded: true })
  })
})
