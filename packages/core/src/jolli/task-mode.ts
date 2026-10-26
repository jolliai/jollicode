export * as JolliTaskMode from "./task-mode"

import { Duration, Effect, Fiber, Option } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { fetchStudentAssignment, gatewayRequest, scopedRequest } from "./api"
import { isAgentPart, requiresExplicitSubmit, type TaskBinding } from "./assignment"
import { JolliAssignmentCache } from "./assignment-cache"
import { isGatewayId, type CourseBinding } from "./binding"
import { parseCourseBinding } from "./org-scoped-id"
import { JolliSession } from "./session"

const TTL_MS = 60_000
const MAX_ENTRIES = 256
type Reading = { checkedAt: number; explicit?: boolean; pending?: Effect.Effect<boolean> }
const readings = new Map<string, Reading>()

/**
 * Tool policy owns its refresh: headless runs and hidden windows must not depend on UI polling.
 * A failed refresh retains the last known mode; concurrent provider turns share one bounded read, and
 * once a mode is known a refresh never delays a provider turn.
 */
export const explicitSubmit = Effect.fn("JolliTaskMode.explicitSubmit")(function* (
  binding: CourseBinding,
  task: TaskBinding,
) {
  const service = yield* Effect.serviceOption(JolliSession.Service)
  if (Option.isNone(service)) return true
  const jolli = service.value
  const row = yield* jolli.current().pipe(Effect.catchCause(() => Effect.succeed(undefined)))
  if (!row) return true
  const key = JSON.stringify([row.base_url, row.cache_key, binding.courseId, task.assignmentId, task.partId])
  const entry: Reading = readings.get(key) ?? { checkedAt: 0 }
  readings.delete(key)
  readings.set(key, entry)
  if (readings.size > MAX_ENTRIES) readings.delete(readings.keys().next().value!)
  const cached = JolliAssignmentCache.assignment(row.cache_key, binding.courseId, task.assignmentId, Date.now())
  const part = cached?.parts.find((part) => String(part.id) === task.partId)
  if (part) {
    entry.explicit = !isAgentPart(part) || requiresExplicitSubmit(part)
    return entry.explicit
  }
  if (Date.now() - entry.checkedAt < TTL_MS) return entry.explicit ?? true
  if (!entry.pending) {
    const pending: Effect.Effect<boolean> = yield* Effect.cached(
      Effect.gen(function* () {
        const ids = parseCourseBinding(binding)
        const scope = row.base_url
          ? gatewayRequest(row.base_url, { token: row.access_token, identity: row.cache_key })
          : undefined
        if (!ids || !scope || !isGatewayId(task.assignmentId)) return entry.explicit ?? true
        const request = yield* jolli.request()
        // A renewal may race a sign-in. Never cache another account's policy under the old one.
        if (
          !request ||
          request.origin !== scope.origin ||
          request.tenantSlug !== scope.tenantSlug ||
          request.identity !== scope.identity
        )
          return entry.explicit ?? true
        const assignment = yield* fetchStudentAssignment(
          scopedRequest(request, ids.org),
          ids.courseId,
          Number(task.assignmentId),
        )
        JolliAssignmentCache.keep(request.identity, binding.courseId, assignment, Date.now())
        const part = assignment.parts.find((part) => String(part.id) === task.partId)
        entry.explicit = !part || !isAgentPart(part) || requiresExplicitSubmit(part)
        return entry.explicit
      }).pipe(
        Effect.timeout(Duration.seconds(5)),
        Effect.catchCause(() => Effect.succeed(entry.explicit ?? true)),
        Effect.ensuring(
          Effect.sync(() => {
            entry.checkedAt = Date.now()
            if (entry.pending === pending) entry.pending = undefined
          }),
        ),
        Effect.provide(FetchHttpClient.layer),
      ),
    )
    entry.pending = pending
  }
  const reader = yield* entry.pending.pipe(Effect.forkDetach)
  // A known mode answers now and refreshes behind the turn; only the first read waits for the gateway.
  if (entry.explicit !== undefined) return entry.explicit
  return yield* Fiber.join(reader)
})

export function reset() {
  readings.clear()
}
