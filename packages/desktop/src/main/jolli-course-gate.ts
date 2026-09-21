/**
 * WHETHER THIS STUDENT HAS ANYWHERE TO WORK, ASKED BEFORE THE APP OPENS.
 *
 * ⚠ IT RUNS IN MAIN BECAUSE THE TOKEN DOES. The credential lives in the OS keychain and never
 * reaches the renderer, so the renderer cannot ask Jolli anything itself. Main was going to make
 * this call regardless — the sidecar's model list is baked into its config before it forks — so the
 * gate rides along on a fetch that already had to happen, and the result is cached for the server
 * to reuse.
 *
 * ⚠ "NO COURSES" AND "COULD NOT ASK" ARE DIFFERENT ANSWERS AND MUST STAY THAT WAY. A dropped
 * connection reported as "none of your courses use Jolli Code" sends a student to their registrar
 * over a Wi-Fi problem. `loadCatalog` already draws that line — it serves a stale snapshot rather
 * than failing, and only reports `unreachable` when it has nothing at all — so this is a thin read
 * of an answer decided elsewhere.
 *
 * ⚠ IT GATES ON HAVING A COURSE, NOT ON HAVING A USABLE ONE. A student whose only course is still a
 * draft is let in, because the course picker can say "your instructor hasn't published this yet"
 * and the gate cannot. Only a student with nothing at all is stopped.
 */
import { Effect } from "effect"
import { gatewayRequest } from "@opencode-ai/core/jolli/api"
import { loadCatalog, STARTUP_DEADLINE } from "@opencode-ai/core/jolli/cache"
import type { JolliSession } from "./jolli-auth"
import type { CourseGateResult } from "../preload/types"

export async function checkCourseGate(session: JolliSession | undefined): Promise<CourseGateResult> {
  if (!session) return { kind: "unreachable" }
  // No tenant means nothing to ask: an older backend that did not report one on exchange.
  if (!session.baseUrl) return { kind: "unreachable" }
  const request = gatewayRequest(session.baseUrl, session.token)
  if (!request) return { kind: "unreachable" }

  /**
   * ⚠ BOUNDED, BECAUSE THIS IS THE SCREEN THE STUDENT IS LOOKING AT. `loadCatalog` never rejects,
   * but "never rejects" and "answers promptly" are different promises and only the second one is
   * any use to someone waiting on a splash. Running out of time reads as `unreachable`, which is
   * the honest answer and already has a retry button behind it.
   */
  const loaded = await Effect.runPromise(loadCatalog(request, { timeout: STARTUP_DEADLINE })).catch(() => undefined)
  if (!loaded || loaded.kind !== "ok") return { kind: "unreachable" }
  return loaded.snapshot.courses.length > 0 ? { kind: "ok" } : { kind: "none" }
}
