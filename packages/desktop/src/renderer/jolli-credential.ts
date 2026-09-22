/**
 * NOTICE A JOLLI CREDENTIAL THAT DISAPPEARED WHILE THIS WINDOW WAS RUNNING.
 *
 * ⚠ THE TUI ALREADY DOES THIS AND THE DESKTOP DID NOT, WHICH IS THE WHOLE BUG. Both surfaces share
 * one credential in one database but fork their own servers, so a sign-out in either is invisible
 * to the other: no event crosses the process boundary — `JolliSession.signOut` publishes nothing,
 * and EventV2 delivery is an in-process PubSub — and each surface's sign-out is a local teardown
 * that only the surface running it performs. `packages/tui/src/context/sync.tsx` closed its half
 * with `refreshConnected`; this is the other half, against the same endpoint and the same helper.
 *
 * ⚠ `connected` IS ALREADY LIVE, SO THERE IS NOTHING TO REBUILD BEFORE ASKING. `connectedProviderIds`
 * in `handlers/provider.ts` filters the Jolli ids by a direct read of the credential store rather
 * than by the provider set the instance resolved at boot, precisely so that another surface signing
 * out is visible without disposing anything. Asking is the entire mechanism.
 *
 * ⚠ AND IT DELIBERATELY REBUILDS NOTHING ITSELF, for the reason `sync.tsx` gives at length: every
 * surface that renders "signed out" keys off `connected`, and disposing the instance to deliver one
 * bit would tear down config, LSP, watchers and project state. Signing back IN is the direction
 * that needs the models rebuilt, and `jolliSignIn` already does it.
 */

import { isJolliConnected } from "@opencode-ai/core/jolli/gateway-config"
import { createEffect, onCleanup } from "solid-js"

/**
 * How often to re-ask whether a credential is still held.
 *
 * Matched to the TUI's own poll rather than chosen independently: long enough not to be a busy
 * loop, short enough that a student who was signed out elsewhere does not keep typing into a
 * composer that cannot send. Polling is only acceptable because the answer is local — `GET
 * /provider` never touches the network for this field, and its handler says so.
 */
export const CONNECTED_POLL_MS = 10_000

/**
 * WHETHER THE CREDENTIAL WAS THERE AND WENT — WHICH IS NOT THE SAME QUESTION AS WHETHER ONE IS HELD
 * RIGHT NOW.
 *
 * ⚠ THE LATCH IS THE WHOLE SUBTLETY, AND WITHOUT IT THIS FEATURE RAISES THE SIGN-IN GATE OVER
 * STUDENTS WHO ARE SIGNED IN. An empty `connected` is also what a launch looks like before the
 * first bootstrap settles, and what a bad read looks like — the trap `dialog-logout.tsx` latches
 * against and `jolli/catalog.ts` documents as "absent means we cannot tell, not signed out". Only a
 * set that HELD a Jolli provider and then stopped is a sign-out.
 *
 * ⚠ IT ALSO ANSWERS TRUE ONCE PER DISAPPEARANCE. The caller raises a gate; repeating that on every
 * poll behind it would reset the screen under a student part-way through signing back in.
 */
export function createCredentialLatch() {
  let held = false
  return (input: { ready: boolean; connected: readonly string[] }) => {
    if (!input.ready) return false
    if (isJolliConnected(input.connected)) {
      held = true
      return false
    }
    if (!held) return false
    held = false
    return true
  }
}

type CredentialSource = {
  readonly ready: boolean
  readonly connected: readonly string[]
  /** Re-reads `GET /provider`; the store this reads `connected` from is what it updates. */
  readonly refresh: () => Promise<unknown>
}

/**
 * Calls `onGone` the first time a held credential stops being held.
 *
 * ⚠ THE FOCUS LISTENER IS WHAT MAKES THE COMMON CASE FEEL IMMEDIATE, and the poll is what covers
 * the rest. Signing out happens in a terminal, so returning to this window is usually the moment
 * the answer changed; the interval is for the window that never lost focus — a TUI in an embedded
 * terminal, or the backend retiring the token, which `jolli/session.ts` also turns into a deleted
 * row.
 */
export function watchJolliCredential(source: () => CredentialSource, onGone: () => void) {
  const gone = createCredentialLatch()
  const ask = () =>
    void source()
      .refresh()
      .catch(() => {})

  const poll = setInterval(ask, CONNECTED_POLL_MS)
  window.addEventListener("focus", ask)
  onCleanup(() => {
    clearInterval(poll)
    window.removeEventListener("focus", ask)
  })

  createEffect(() => {
    if (gone({ ready: source().ready, connected: source().connected })) onGone()
  })
}
