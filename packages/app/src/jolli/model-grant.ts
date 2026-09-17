/**
 * WHICH MODELS THE CURRENT ASSISTANT MAY RUN ON.
 *
 * ⚠ A MODULE SIGNAL RATHER THAN A CONTEXT, AND THE REASON IS PROVIDER ORDER, NOT TASTE.
 * `ModelsProvider` mounts ABOVE `CourseSessionProvider` on both routes that have one — it wraps
 * `SDKProvider` on the draft route and sits inside `ServerScopedProviders` on the session route — so
 * the models context cannot call `useCourseSession()` without inverting a stack that upstream owns.
 * Moving `ModelsProvider` down instead would put a fork's ordering requirement in the middle of the
 * application shell, which is the change most likely to break on a rebase.
 *
 * ⚠ IT IS THE NARROWEST POSSIBLE THING: one list of strings, written by exactly one effect (in
 * `session-binding.tsx`) and read by exactly one memo (`available()` in `context/models.tsx`). If a
 * third caller ever appears, that is the signal to do this properly with a provider.
 *
 * ⚠ AND IT IS A DISPLAY FILTER, NOT ENFORCEMENT. A student who cannot see a model here cannot pick
 * one, which is all a UI can honestly claim. The gateway is what refuses a model a course did not
 * grant; nothing in the renderer should be mistaken for that.
 */

import { createSignal } from "solid-js"

const [allowed, setAllowed] = createSignal<string[]>([])
const [preferred, setPreferred] = createSignal<string | undefined>(undefined)
const [bound, setBound] = createSignal(false)

export const ModelGrant = {
  allowed,
  /**
   * THE MODEL THE PROFESSOR SET ON THIS ASSISTANT, IF ANY. Read once, by the selection chain in
   * `context/local.tsx`, where it comes before every other default — see `Assistant.modelId`.
   */
  preferred,
  /**
   * WHETHER AN ASSISTANT IS IN FORCE AT ALL, WHICH IS NOT THE SAME AS AN EMPTY GRANT. No assistant
   * means no course has been chosen yet and there is nothing to run: the composer greys its model
   * control rather than offering the whole catalogue. An empty grant means an assistant with no
   * restriction, which offers everything on purpose.
   */
  bound,
  /** Called from the course binding whenever the assistant in force changes. */
  set(next: { allowed: string[]; preferred?: string; bound: boolean }) {
    setAllowed(next.allowed)
    setPreferred(next.preferred)
    setBound(next.bound)
  },
}

/**
 * ⚠ AN EMPTY GRANT MEANS UNRESTRICTED. A course that has not thought about model access must behave
 * exactly like the product did before this existed — the alternative, an empty picker, would read as
 * a broken application rather than as an unconfigured course.
 */
export function isModelAllowed(providerID: string, modelID: string): boolean {
  const list = allowed()
  if (list.length === 0) return true
  return list.includes(`${providerID}/${modelID}`)
}
