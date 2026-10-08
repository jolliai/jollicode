import type { Accessor } from "solid-js"
import { createStore, produce, unwrap, type SetStoreFunction, type Store } from "solid-js/store"
import type { Prompt } from "@/context/prompt"
import { Persist, persisted } from "@/utils/persist"
import {
  clonePromptHistoryComments,
  clonePromptParts,
  dropHistoryScope,
  prependScopedHistoryEntry,
  promoteHistoryScope,
  type PromptHistoryComment,
  type PromptHistoryScopes,
  type PromptHistoryStoredEntry,
} from "./history"

export type PromptInputHistory = {
  entries: (mode: "normal" | "shell") => PromptHistoryStoredEntry[]
  add: (prompt: Prompt, mode: "normal" | "shell", comments: PromptHistoryComment[], scope?: string) => void
  promote: (from: string, to: string) => void
  discard: (scope: string) => void
}

type PromptHistoryState = { scopes: PromptHistoryScopes }

const EMPTY: PromptHistoryStoredEntry[] = []
const DEFAULT_SCOPE = "global"

function createPromptInputHistoryStore(
  scope: Accessor<string> | undefined,
  normal: Store<PromptHistoryState>,
  setNormal: SetStoreFunction<PromptHistoryState>,
  shell: Store<PromptHistoryState>,
  setShell: SetStoreFunction<PromptHistoryState>,
): PromptInputHistory {
  /**
   * A caller that cannot say which chat it is in — stories, fixtures — gets one bucket for reads
   * *and* writes. Honouring a scoped `target` for such a caller would file entries under a key
   * `entries` never reads back, leaving ↑ permanently empty.
   */
  const bucket = (target?: string) => (scope ? (target ?? scope()) : DEFAULT_SCOPE)

  const write = (
    state: Store<PromptHistoryState>,
    setState: SetStoreFunction<PromptHistoryState>,
    next: PromptHistoryScopes,
  ) => {
    if (next === state.scopes) return
    /**
     * ⚠ EXACTLY ONE SETTER CALL, BECAUSE EVERY SETTER CALL IS A WRITE TO DISK. `makePersisted`
     * wraps the setter and serializes the whole store inside it, and `batch` does not reach that —
     * it defers reactive readers, not an imperative `storage.setItem`. So a two-step update that
     * clears the object before writing the new one leaves `{"scopes":{}}` on disk in between, and
     * a window closed (or a failed second write) in that gap loses every chat's history.
     *
     * Assigning through `produce` replaces the object wholesale in one call: keys that were
     * trimmed or promoted away actually disappear (a plain path assignment would merge them back),
     * and the new key order survives — order *is* the recency record that `touchScope` keeps, and
     * what the scope cap evicts by.
     */
    setState(
      produce((draft) => {
        draft.scopes = unwrap(next)
      }),
    )
  }

  return {
    entries: (mode) => (mode === "shell" ? shell.scopes : normal.scopes)[bucket()] ?? EMPTY,
    add(prompt, mode, comments, target) {
      const current = mode === "shell" ? shell : normal
      const setCurrent = mode === "shell" ? setShell : setNormal
      write(current, setCurrent, prependScopedHistoryEntry(current.scopes, bucket(target), prompt, comments))
    },
    promote(from, to) {
      write(normal, setNormal, promoteHistoryScope(normal.scopes, from, to))
      write(shell, setShell, promoteHistoryScope(shell.scopes, from, to))
    },
    discard(scope) {
      write(normal, setNormal, dropHistoryScope(normal.scopes, scope))
      write(shell, setShell, dropHistoryScope(shell.scopes, scope))
    },
  }
}

export function createPromptInputHistory(scope?: Accessor<string>): PromptInputHistory {
  const [normal, setNormal] = createStore<PromptHistoryState>({ scopes: {} })
  const [shell, setShell] = createStore<PromptHistoryState>({ scopes: {} })
  return createPromptInputHistoryStore(scope, normal, setNormal, shell, setShell)
}

/**
 * Drops the pre-scope flat list: those entries carry no chat to attribute them to, and replaying
 * them in every conversation is the bug this scoping exists to fix.
 */
function migrateScopes(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value
  if (!("entries" in value)) return value
  const { entries: _legacy, ...rest } = value as Record<string, unknown>
  return rest
}

function historyTarget(key: string, legacy: string[]) {
  return Persist.prompt({ ...Persist.global(key, legacy), migrate: migrateScopes })
}

export function createPersistedPromptInputHistory(scope?: Accessor<string>) {
  const [normal, setNormal, normalInit] = persisted(
    historyTarget("prompt-history", ["prompt-history.v1"]),
    createStore<PromptHistoryState>({ scopes: {} }),
  )
  const [shell, setShell, shellInit] = persisted(
    historyTarget("prompt-history-shell", ["prompt-history-shell.v1"]),
    createStore<PromptHistoryState>({ scopes: {} }),
  )
  const history = createPromptInputHistoryStore(scope, normal, setNormal, shell, setShell)
  return {
    ...history,
    add(prompt: Prompt, mode: "normal" | "shell", comments: PromptHistoryComment[], target?: string) {
      const ready = mode === "shell" ? shellInit : normalInit
      if (!(ready instanceof Promise)) return history.add(prompt, mode, comments, target)
      const saved = clonePromptParts(prompt)
      const metadata = clonePromptHistoryComments(comments)
      // Pin the scope now: the write lands after the session may already have been created.
      const pinned = target ?? scope?.()
      void ready.then(() => history.add(saved, mode, metadata, pinned))
    },
    promote(from: string, to: string) {
      queue(() => history.promote(from, to))
    },
    discard(target: string) {
      queue(() => history.discard(target))
    },
  }

  // Queued behind the same gate as `add`, so neither ever runs before the entry it acts on.
  function queue(run: () => void) {
    const loading = [normalInit, shellInit].filter((value): value is Promise<string> => value instanceof Promise)
    if (loading.length === 0) return run()
    void Promise.all(loading).then(run)
  }
}
