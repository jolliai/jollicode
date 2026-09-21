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

import { Lookup } from "@opencode-ai/core/jolli/lookup"
import { createSignal } from "solid-js"

/** Re-exported so this package's ~5 callers keep naming the grant vocabulary in one place. */
export const parseModelKey = Lookup.parseModelKey

const [allowed, setAllowed] = createSignal<readonly string[]>([])
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
  /**
   * THE ONE MODEL A COURSE GRANTED, WHEN IT GRANTED EXACTLY ONE.
   *
   * ⚠ THE PROFESSOR'S DEFAULT IS NOT GUARANTEED TO BE IN THEIR OWN GRANT — nothing on the gateway
   * enforces that `modelId` appears in `allowedModelIds`. When the two disagree the preferred model
   * is rejected as unrunnable and the chain falls through to a provider scan that happens to land on
   * the only allowed model. Correct, but by coincidence: make it the answer instead.
   *
   * ⚠ IT LIVES HERE BECAUSE BOTH SELECTION CHAINS NEED IT — the workspace one in `context/local.tsx`
   * and the composer's in `prompt-model-selection.ts`. Two copies meant the grant key format and the
   * exactly-one rule had to be changed in both, and the two screens disagreeing about which model a
   * course auto-selects is what that drift would look like.
   *
   * ⚠ IT DOES NOT CHECK THAT THE MODEL CAN BE RUN, because its two callers check at different
   * moments: one validates each candidate as it builds the chain, the other validates the finished
   * list. What they must agree on is what the grant SAYS, which is all this decides.
   */
  only() {
    const list = allowed()
    if (list.length !== 1) return
    return parseModelKey(list[0])
  },
  /** Called from the course binding whenever the assistant in force changes. */
  set(next: { allowed: readonly string[]; preferred?: string; bound: boolean }) {
    setAllowed(next.allowed)
    setPreferred(next.preferred)
    setBound(next.bound)
  },
}

export function isModelAllowed(providerID: string, modelID: string): boolean {
  return Lookup.isModelAllowed(allowed(), providerID, modelID)
}
