/**
 * WHETHER THIS STUDENT HAS ANYWHERE TO WORK, ASKED BEFORE THE APP OPENS.
 *
 * ⚠ IT ASKS THE SIDECAR NOW, NOT THE GATEWAY. It used to call Jolli directly because the credential
 * lived in this process; it does not any more, and `/jolli/course` is the same projection the
 * renderer already reads. One caller, one answer, one place that decides what `unreachable` means.
 *
 * ⚠ IT ALSO WARMS THE CACHE THE SERVER'S CONFIG LOADER DEPENDS ON, AND THAT IS NOT INCIDENTAL. The
 * Jolli floor in `config.ts` fetches the tenant catalogue when it assembles a config, bounded by
 * `STARTUP_DEADLINE`; the desktop used to warm that cache before forking the sidecar. This call is
 * what replaced that, which is why the sign-in flow makes it before disposing the instance.
 *
 * ⚠ "NO COURSES" AND "COULD NOT ASK" ARE DIFFERENT ANSWERS AND MUST STAY THAT WAY. A dropped
 * connection reported as "none of your courses use Jolli Code" sends a student to their registrar
 * over a Wi-Fi problem. The server already draws that line — it serves a stale snapshot rather than
 * failing, and only reports `unreachable` when it has nothing at all.
 *
 * ⚠ IT GATES ON HAVING A COURSE, NOT ON HAVING A USABLE ONE. A student whose only course is still a
 * draft is let in, because the course picker can say "your instructor hasn't published this yet"
 * and the gate cannot. Only a student with nothing at all is stopped.
 */
import type { SidecarCall } from "./jolli-sidecar"
import type { CourseGateResult } from "../preload/types"

type CourseList = { status?: string; courses?: unknown[] }

/**
 * ⚠ LONGER THAN THE SERVER'S OWN BOUND, WHICH THE TEN-SECOND DEFAULT IS NOT. `/jolli/course` gives
 * a cold catalogue fetch `REFRESH_DEADLINE` — 45 seconds in `core/src/jolli/cache.ts` — before it
 * gives up and serves what it has. A client that quits first turns a slow-but-successful load into
 * `unreachable`: the gate the student is waiting behind fails, and the cache warming this call
 * exists to do is thrown away at the moment it was about to pay off. Whoever moves that deadline
 * has to move this one.
 */
const COURSE_TIMEOUT_MS = 60_000

export async function checkCourseGate(call: SidecarCall | undefined): Promise<CourseGateResult> {
  // No server yet is the same answer as no answer: a question we never got to ask.
  if (!call) return { kind: "unreachable" }

  const catalog = await call<CourseList>("/jolli/course", { timeoutMs: COURSE_TIMEOUT_MS }).catch(() => undefined)
  if (!catalog || catalog.status !== "ok") return { kind: "unreachable" }
  return (catalog.courses?.length ?? 0) > 0 ? { kind: "ok" } : { kind: "none" }
}
