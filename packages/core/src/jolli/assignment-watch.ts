/** Refresh after turn settlement; streaming/tool parts are not completion evidence. */
export function assignmentSettledSession(event: { type: string; properties?: unknown; data?: unknown }) {
  const data = event.properties ?? event.data
  if (!data || typeof data !== "object" || !("sessionID" in data) || typeof data.sessionID !== "string")
    return undefined
  if (event.type === "session.status") {
    if (!("status" in data) || !data.status || typeof data.status !== "object") return undefined
    return "type" in data.status && data.status.type === "idle" ? data.sessionID : undefined
  }
  if (event.type === "session.next.step.ended" && "finish" in data && data.finish === "tool-calls") return undefined
  if (
    event.type === "session.execution.succeeded" ||
    event.type === "session.execution.failed" ||
    event.type === "session.execution.interrupted" ||
    event.type === "session.next.step.ended" ||
    event.type === "session.next.step.failed" ||
    event.type === "session.error"
  )
    return data.sessionID
  return undefined
}

/** Share pending reads; settlement requests one fresh trailing read after any older snapshot. */
export function createAssignmentRefresh<T>(
  load: (fresh: boolean) => Promise<T>,
  accept: (answer: T) => void = () => {},
) {
  const pending = {
    request: undefined as Promise<T> | undefined,
    again: false,
    fresh: false,
    reading: false,
    disposed: false,
  }
  const refresh = (fresh = false): Promise<T> => {
    if (pending.request) {
      if (fresh || !pending.reading) {
        pending.again = true
        pending.fresh ||= fresh
      }
      return pending.request
    }
    pending.fresh = fresh
    pending.request = (async () => {
      for (;;) {
        pending.again = false
        const fresh = pending.fresh
        pending.fresh = false
        pending.reading = true
        const answer = await load(fresh)
        pending.reading = false
        if (!pending.disposed) accept(answer)
        if (!pending.again || pending.disposed) return answer
      }
    })().then(
      (answer) => {
        pending.request = undefined
        // A settlement or poll may arrive after publication but before promise completion.
        return pending.again && !pending.disposed ? refresh(pending.fresh) : answer
      },
      (error) => {
        pending.request = undefined
        pending.reading = false
        // A settlement queued behind a failed read still needs its own read.
        if (pending.again && !pending.disposed) return refresh(pending.fresh)
        throw error
      },
    )
    return pending.request
  }
  return {
    refresh,
    loading: () => pending.request !== undefined,
    dispose: () => {
      pending.disposed = true
    },
  }
}
