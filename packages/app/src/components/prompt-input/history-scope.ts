import type { Accessor } from "solid-js"
import { pathKey } from "@/utils/path-key"
import { ScopedKey, type ServerScope } from "@/utils/server-scope"
import { pendingHistoryScope, sessionHistoryScope } from "./history"
import { createPersistedPromptInputHistory, type PromptInputHistory } from "./history-store"

type PromptHistoryScopeInput = {
  /**
   * Supplied by stories and tests. Such a history is built without a scope accessor, and
   * `createPromptInputHistoryStore` then ignores the scope handed to `add` — reads and writes
   * share one bucket rather than writing scoped and reading unscoped.
   */
  history?: PromptInputHistory
  sessionID: Accessor<string | undefined>
  serverScope: Accessor<ServerScope>
  directory: Accessor<string>
  /** Tells two new chats on the same folder apart before either has a session. */
  draftID?: Accessor<string | undefined>
}

/**
 * Binds prompt history to the chat the composer is currently showing, and owns the one piece of
 * state the composer cannot derive: which bucket the prompt being submitted went into.
 *
 * ⚠ SHARED BY BOTH COMPOSERS. v1 and v2 each submit through `createPromptSubmit`, so a copy in each
 * would be two places to keep in step — and the halves only ever show their disagreement as history
 * silently landing in the wrong chat, which no screen makes visible.
 */
export function createPromptHistoryScope(input: PromptHistoryScopeInput) {
  // Keys are normalized the way the rest of the app normalizes them: scoped by server, paths through
  // `pathKey`, so one chat cannot end up with two buckets because of a drive-letter slash.
  const session = (sessionID: string) => ScopedKey.from(input.serverScope(), sessionHistoryScope(sessionID))
  const pending = () =>
    ScopedKey.from(input.serverScope(), pendingHistoryScope(pathKey(input.directory()), input.draftID?.()))
  const scope = () => {
    const sessionID = input.sessionID()
    return sessionID ? session(sessionID) : pending()
  }

  const history = input.history ?? createPersistedPromptInputHistory(scope)

  /** Set only while a prompt submitted from a sessionless chat is still waiting for its session. */
  let outstanding: string | undefined
  const take = () => {
    const value = outstanding
    outstanding = undefined
    return value
  }

  return {
    history,
    scope,
    /** Call as a prompt is submitted; returns the bucket the entry must be written to. */
    submitted() {
      const target = scope()
      outstanding = input.sessionID() ? undefined : target
      return target
    },
    /** The submit created a session: hand it the entry so Up still finds it there. */
    promote(sessionID: string) {
      const from = take()
      if (from) history.promote(from, session(sessionID))
    },
    /** The submit created no session: forget the entry rather than leak it into the next new chat. */
    discard() {
      const from = take()
      if (from) history.discard(from)
    },
  }
}

export type PromptHistoryScope = ReturnType<typeof createPromptHistoryScope>
