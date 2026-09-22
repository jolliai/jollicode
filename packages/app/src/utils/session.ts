import type { SessionApi, SessionInfo, SessionListInput } from "@opencode-ai/client/promise"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { withTimestampedFallback } from "./session-title"

/**
 * ⚠ `metadata` IS DECLARED HERE BECAUSE THE VENDORED CLIENT'S TYPES PREDATE IT. `@opencode-ai/client`
 * ships as a tarball in `packages/app/vendor`, so its `SessionInfo` cannot be regenerated alongside
 * a server-side schema change; the field is on the wire (see `schema/src/session.ts` and
 * `core/src/session/info.ts`) and a stale `.d.ts` is not a reason to throw the value away. Declaring
 * the intersection beats an inline cast: it says what the payload actually is, once.
 */
export type SessionInfoWithMetadata = SessionInfo & { metadata?: Record<string, unknown> }

/**
 * ⚠ THIS REBUILDS THE OBJECT FIELD BY FIELD, SO ANY FIELD LEFT OUT IS DELETED RATHER THAN IGNORED —
 * which is how `metadata` came to be dropped from every session read through a v2 list. That bag is
 * where Jolli keeps a session's course binding (`core/jolli/binding.ts`), so a session opened from
 * the session list came back with no course, no assistant and no model grant, while one created in
 * the same renderer looked fine purely on `session-binding.tsx`'s one-frame `handoff` cache.
 */
export function normalizeSessionInfo(input: SessionInfoWithMetadata | Session): Session {
  if (!("location" in input)) return input
  return {
    metadata: input.metadata,
    id: input.id,
    slug: input.id,
    projectID: input.projectID,
    workspaceID: input.location.workspaceID,
    directory: input.location.directory,
    path: input.subpath,
    parentID: input.parentID,
    cost: input.cost,
    tokens: input.tokens,
    title: withTimestampedFallback(input),
    agent: input.agent,
    model: input.model,
    version: "",
    time: input.time,
    revert: input.revert && {
      messageID: input.revert.messageID,
      partID: input.revert.partID,
      snapshot: input.revert.snapshot,
    },
  }
}

export async function listAllSessions(api: Pick<SessionApi, "list">, input: Omit<SessionListInput, "cursor">) {
  const load = async (cursor?: string): Promise<Session[]> => {
    const result = await api.list({ ...input, limit: input.limit ?? 100, cursor })
    const sessions = result.data.map(normalizeSessionInfo)
    if (result.data.length === 0 || !result.cursor.next) return sessions
    return [...sessions, ...(await load(result.cursor.next))]
  }
  return load()
}
