/**
 * A STUDENT'S ASSIGNMENTS AS LAST READ, FOR A MINUTE.
 *
 * ⚠ PROCESS MEMORY, KEYED BY WHO ASKED. The sidecar serves the TODO list on every sidebar render and
 * a session's "Handed in" label on every header; asking the gateway each time would be a request per
 * course per render. `identity` is the credential's cache key (`GatewayRequest.identity`), so two
 * students on one machine never read each other's, and a token refresh does not empty it.
 *
 * ⚠ A HAND-IN OR A TURN-IN WRITES WHAT THE GATEWAY ANSWERED, AT ONCE. The label and the list must
 * change the moment the student's approval lands, not a minute later; the answer is the assignment
 * as it now stands, so it is stored rather than the entry dropped.
 *
 * ⚠ WHAT IS KEPT IS THE GATEWAY'S SHAPE, NOT A SCREEN'S. Which of a task's sessions is on this machine
 * changes without the gateway knowing, so it is worked out on every read, never cached.
 */
export * as JolliAssignmentCache from "./assignment-cache"

import type { Jolli } from "@opencode-ai/schema/jolli"
import type { StudentAssignment, StudentAssignmentPart } from "./api"

const TTL_MS = 60_000

/** Entries kept per kind; a long-lived sidecar would otherwise keep every assignment ever opened. */
const MAX_ENTRIES = 256

type Entry<T> = { readonly at: number; readonly value: T }

const lists = new Map<string, Entry<Jolli.AssignmentSummary[]>>()
const assignments = new Map<string, Entry<StudentAssignment>>()

function keyOf(identity: string, courseId: string, assignmentId: string) {
  return `${identity}:${courseId}:${assignmentId}`
}

function fresh<T>(entry: Entry<T> | undefined, now: number) {
  return entry && now - entry.at < TTL_MS ? entry.value : undefined
}

function remember<T>(map: Map<string, Entry<T>>, key: string, value: T, now: number) {
  map.delete(key)
  map.set(key, { at: now, value })
  if (map.size <= MAX_ENTRIES) return
  const oldest = map.keys().next().value
  if (oldest !== undefined) map.delete(oldest)
}

/** The TODO list read within the last minute, or undefined. */
export function list(identity: string, now: number) {
  return fresh(lists.get(identity), now)
}

export function putList(identity: string, value: Jolli.AssignmentSummary[], now: number) {
  remember(lists, identity, value, now)
}

/** One assignment read within the last minute, or undefined. */
export function assignment(identity: string, courseId: string, assignmentId: string, now: number) {
  return fresh(assignments.get(keyOf(identity, courseId, assignmentId)), now)
}

/** Keep an assignment as a read answered it. */
export function keep(identity: string, courseId: string, value: StudentAssignment, now: number) {
  remember(assignments, keyOf(identity, courseId, String(value.id)), value, now)
}

/** An assignment was turned in: keep it as the turn-in answered, and read the list again. */
export function turnedIn(identity: string, courseId: string, value: StudentAssignment, now: number) {
  keep(identity, courseId, value, now)
  // An assignment turned in leaves the list.
  lists.delete(identity)
}

/**
 * A TASK WAS HANDED IN: ITS PART, AS THE GATEWAY ANSWERED IT, REPLACES THE ONE KEPT.
 *
 * ⚠ AN ASSIGNMENT NOT KEPT IS LEFT FOR THE NEXT READ, rather than made up from one part.
 */
export function handedIn(
  identity: string,
  courseId: string,
  assignmentId: string,
  part: StudentAssignmentPart,
  now: number,
) {
  lists.delete(identity)
  const key = keyOf(identity, courseId, assignmentId)
  const kept = assignments.get(key)?.value
  if (!kept) return
  remember(assignments, key, { ...kept, parts: kept.parts.map((item) => (item.id === part.id ? part : item)) }, now)
}

/**
 * A HAND-IN OR TURN-IN WHOSE ANSWER NEVER CAME: forget the assignment and the list, so the student's
 * next look reads what the gateway kept rather than what was kept here before it.
 */
export function forget(identity: string, courseId: string, assignmentId: string) {
  lists.delete(identity)
  assignments.delete(keyOf(identity, courseId, assignmentId))
}

/** Forget everything: for tests, and a sign-out that should not wait a minute. */
export function reset() {
  lists.clear()
  assignments.clear()
}
