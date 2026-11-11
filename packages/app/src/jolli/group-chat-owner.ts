import { createStore } from "solid-js/store"
import type { Platform } from "@/context/platform"
import { Persist, persisted } from "@/utils/persist"

/**
 * The owner of chats a window kept from an earlier run without a record of whose they are: a build from before
 * owners were recorded wrote them, or the run stopped between writing a tab and writing its owner. No list names
 * it, so the first list drops them, as it drops another person's.
 */
export const unknownGroupChatOwner = Symbol("unknown group chat owner")

/**
 * Whose group chats one window holds, per server: the owner (a fingerprint of deployment, tenant and person)
 * the last list it took named. Kept with the window's tabs and like them, so two windows never read or
 * overwrite each other's record, and storage that fails is handled where theirs is.
 *
 * `kept` answers, once the window's tabs have loaded, the servers whose group chat tabs (open or closed) it
 * kept from an earlier run. Such a server with no owner recorded holds {@link unknownGroupChatOwner}'s chats.
 * Tabs opened during this run never count: a chat opened from a notification, a restored address or the history
 * before the first list answers is the person's now signed in, and that list must not close it.
 *
 * A reset deletes the record rather than marking the server as holding nothing: tabs written after it, before a
 * list named their owner, are of nobody this window recorded either, and are kept tabs at the next start.
 */
export function createGroupChatOwners(platform?: Platform, kept?: Promise<readonly string[]>) {
  const [owners, setOwners, , ready] = persisted(
    Persist.window("groupChat.owners"),
    createStore<Record<string, string | undefined>>({}),
    platform,
  )
  // Settled once both the record and the tabs have loaded; a later take or forget settles its server for good.
  const unknown = Promise.all([ready.promise, kept]).then(
    (loaded) => new Set((loaded[1] ?? []).filter((server) => owners[server] === undefined)),
  )
  // A change made before the record loads would be written over every server's entry, so it waits.
  const change = (server: string, owner: string | undefined) => {
    void unknown.then((servers) => servers.delete(server))
    if (ready()) {
      setOwners(server, owner)
      return
    }
    void ready.promise?.then(() => setOwners(server, owner))
  }
  return {
    /**
     * The owner of the chats this window holds for `server`, once its record and its tabs have loaded:
     * {@link unknownGroupChatOwner} for chats kept without a record, `undefined` when it holds none it kept.
     */
    async held(server: string) {
      const servers = await unknown
      const owner = owners[server]
      if (owner !== undefined) return owner
      return servers.has(server) ? unknownGroupChatOwner : undefined
    },
    /** Records the owner of a list this window took. */
    take: (server: string, owner: string) => change(server, owner),
    /** This window holds none of the server's chats any more, so the next list's owner is taken as it comes. */
    forget: (server: string) => change(server, undefined),
  }
}

export type GroupChatOwners = ReturnType<typeof createGroupChatOwners>

/** Whose chats a window holds for a server, as {@link GroupChatOwners.held} answers it. */
export type GroupChatHolder = Awaited<ReturnType<GroupChatOwners["held"]>>
