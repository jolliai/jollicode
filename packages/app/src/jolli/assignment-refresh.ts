/**
 * WHEN TO READ THE STUDENT'S ASSIGNMENTS AGAIN.
 *
 * ⚠ APART FROM `assignments.ts` SO THE START PATH CAN RAISE IT WITHOUT THE SERVER CONTEXT. A task's
 * Start refreshes the list from `prompt-input/submit.ts`, which must not take the server SDK's context
 * module — and everything it brings — along with one signal.
 */

import { createSignal } from "solid-js"
import { catalogGeneration } from "./catalog"

/** Raised by every refresh; the list and every assignment read key on it. */
const [generation, setGeneration] = createSignal(0)
/** Whether the next list read must reach past the sidecar's cache. */
let fresh = false

/** Ask for the list, and every assignment on screen, again — past the sidecar's cache. */
export function refreshAssignments() {
  fresh = true
  setGeneration((count) => count + 1)
}

/** What a read of the assignments should depend on: a refresh, and a sign-in. */
export function assignmentsGeneration() {
  return generation() + catalogGeneration() * 1_000_000
}

/** Whether the read about to be made was asked for fresh; answering clears it. */
export function takeFresh() {
  const asked = fresh
  fresh = false
  return asked
}
