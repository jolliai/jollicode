import { Brand } from "@opencode-ai/core/brand"
import { isJolliConnected } from "@opencode-ai/core/jolli/gateway-config"
import { createEffect, createMemo, Show } from "solid-js"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { DialogAlert } from "../ui/dialog-alert"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"

/**
 * HAND THIS MACHINE BACK.
 *
 * ⚠ THE PICKER HAS ALWAYS ASSUMED THIS EXISTED. `dialog-provider.tsx` refuses to re-run a sign-in
 * for somebody who already holds a credential and says "switching accounts goes through an explicit
 * sign-out first" — but until now there was no sign-out on this surface, so that sentence described
 * a route a student could only take by quitting and running `jollicode providers logout`.
 *
 * ⚠ IT CONFIRMS, UNLIKE `/login`. Signing in is recoverable by signing in again; this throws away
 * a credential and, through {@link forgetJolliCatalog} on the server, the cached course catalogue
 * with it. One keystroke away from an irreversible act is the wrong distance.
 *
 * ⚠ AND IT REBUILDS THE INSTANCE RATHER THAN JUST DROPPING THE CREDENTIAL. The Jolli provider block
 * is CONFIG, assembled from the credential when the server starts — removing the row from
 * `auth.json` leaves a running server still declaring the models it read at boot. `dispose()` makes
 * it build that answer again, and `bootstrap()` makes this process read the new one. Exactly the
 * sequence `ApiMethod` runs after a successful sign-in, for the same reason in reverse.
 */
export function DialogLogout() {
  const sync = useSync()
  const sdk = useSDK()
  const dialog = useDialog()
  const toast = useToast()

  /**
   * ⚠ `provider_next.connected` RATHER THAN THE PROVIDER LIST, because it is the signal that means
   * "a credential is held" on both surfaces — the bare CLI keeps the JWT in `auth.json` and the
   * desktop in the OS keychain, and the list route counts either. `dialog-provider.tsx` reads the
   * same field to decide whether there is anything to sign in to.
   *
   * ⚠ CHECKS ANY OF THE PER-PROTOCOL PROVIDER IDS (`jolli-anthropic`, `jolli-openai`,
   * `jolli-google`), NOT THE BARE `jolli` SLUG. The gateway config emits one provider per wire
   * protocol; the bare slug is now only the AUTH id (a single credential feeds all three blocks).
   */
  const signedIn = createMemo(() => isJolliConnected(sync.data.provider_next.connected))

  /**
   * ⚠ IT WAITS FOR `complete` BEFORE CONCLUDING "NOT SIGNED IN". A bootstrap still in flight reports
   * an empty connected set, and acting on that would answer "you are not signed in" to a student who
   * is — the same trap `dialog-provider.tsx` documents at length, latched here for the same reason.
   */
  let acted = false
  createEffect(() => {
    if (acted || sync.status !== "complete" || signedIn()) return
    acted = true
    toast.show({ message: `Not signed in to ${Brand.platform}`, variant: "info" })
    dialog.clear()
  })

  async function signOut() {
    const removed = await sdk.client.auth.remove({ providerID: Brand.short })
    if (removed.error) {
      toast.show({ message: `Could not sign out of ${Brand.platform}`, variant: "error", duration: 5000 })
      return
    }
    await sdk.client.instance.dispose()
    await sync.bootstrap()
    toast.show({ message: `Signed out of ${Brand.platform}`, variant: "info" })
  }

  return (
    <Show when={signedIn()}>
      <DialogAlert
        title={`Sign out of ${Brand.platform}`}
        message="This removes your credential and your cached course list from this machine. Press enter to sign out, or esc to stay signed in."
        onConfirm={() => void signOut()}
      />
    </Show>
  )
}
