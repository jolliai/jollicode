/**
 * SIGNING THE STUDENT IN TO JOLLI — BY DRIVING THE SIDECAR, NOT BY DOING IT HERE.
 *
 * ⚠ THE MAIN PROCESS IS NOT A WRITER OF THE CREDENTIAL STORE, AND THAT IS THE CONTRACT THIS FILE
 * EXISTS TO STATE. The sidecar owns the sign-in: it runs the loopback callback, it writes the
 * shared database, and it refreshes the token when it ages. One writer means the write/refresh race
 * between two processes does not need locking — it cannot happen.
 *
 * ⚠ IT ALSO MEANS THE DESKTOP AND THE TUI NOW SHARE ONE SIGN-IN IMPLEMENTATION, which was the point
 * of the exercise. Both call `POST /provider/:id/oauth/authorize`, open the URL themselves, and
 * then call `POST /provider/:id/oauth/callback`. The plugin deliberately does not open a browser —
 * `authorize` runs inside a server that is not always the machine the user is sitting at.
 *
 * ⚠ AND THE OS KEYCHAIN IS GONE FROM THIS PATH. `safeStorage` bought encryption at rest that no
 * other surface could read, which is precisely why signing in on the desktop left the TUI signed
 * out. The credential is in the shared database at 0600 now, the way gcloud and the AWS CLI keep
 * theirs.
 */
import { app } from "electron"
import { Brand } from "@opencode-ai/app/brand"
import { isJolliConnected } from "@opencode-ai/core/jolli/gateway-config"
import { write as writeLog } from "./logging"
import type { SidecarCall } from "./jolli-sidecar"
import { getLastFocusedWindow, openExternalURL } from "./windows"

/** The one method the Jolli plugin registers. */
const METHOD = 0

const AUTHORIZE = `/provider/${Brand.short}/oauth/authorize`
const CALLBACK = `/provider/${Brand.short}/oauth/callback`

/**
 * ⚠ THE CALLBACK CALL WAITS ON A HUMAN IN A BROWSER, so it gets a bound measured in minutes rather
 * than the ten seconds every other call here uses. Shorter than the plugin's own loopback lifetime,
 * because a timeout the client owns produces a message; one the server owns produces a hang.
 */
const CALLBACK_TIMEOUT_MS = 5 * 60_000

/**
 * ⚠ LONGER THAN THE TEN-SECOND DEFAULT, BECAUSE THIS IS THE FIRST CALL OF THE LAUNCH AND IT PAYS
 * FOR THE WHOLE CONFIG. `/provider` reads the instance config, and assembling one resolves the
 * Jolli floor: a token renewal when the stored one is near expiry, then the tenant's catalogue,
 * bounded together by `STARTUP_DEADLINE` — 20 seconds in `core/src/jolli/cache.ts`. Nothing has
 * warmed either at this point; `onboarding.tsx` calls this BEFORE the course gate, which is the
 * call that was given its own 60-second bound for the same reason.
 *
 * ⚠ AND QUITTING EARLY HERE DOES NOT READ AS "SLOW", IT READS AS "SIGNED OUT". The main process
 * answers false on any failure, so the cost of a bound that is too short is the sign-in gate coming
 * up in front of a student who is already signed in — the same symptom the spelling bug below
 * produced, arrived at from the other direction.
 */
const PROVIDER_TIMEOUT_MS = 30_000

/** Runs the browser sign-in end to end, inside the sidecar. Throws with a readable message. */
export async function signIn(call: SidecarCall) {
  const started = await call<{ url: string } | null>(AUTHORIZE, {
    method: "POST",
    body: JSON.stringify({ method: METHOD }),
  })
  if (!started?.url) throw new Error("Jolli sign-in could not be started.")

  writeLog("jolli-auth", "sign-in started")
  openExternalURL(started.url)

  await call(CALLBACK, {
    method: "POST",
    body: JSON.stringify({ method: METHOD }),
    timeoutMs: CALLBACK_TIMEOUT_MS,
  })
  writeLog("jolli-auth", "sign-in completed")
  raiseWindow()
}

/**
 * ⚠ THE SAME SIGNAL THE TUI USES, deliberately. `connected` is the server's answer to "is there a
 * usable credential", and it counts a stored one even when the catalogue could not be fetched and
 * the provider therefore resolved to nothing — which is exactly the case a signed-in student on a
 * bad network lands in. Anything this process computed for itself would disagree with the TUI on
 * the same machine.
 *
 * ⚠ AND IT ASKS THROUGH `isJolliConnected` RATHER THAN LOOKING FOR THE BARE `jolli` SLUG, which is
 * the one spelling the answer never contains. The gateway config declares one provider per wire
 * protocol (`jolli-anthropic`, `jolli-openai`, `jolli-google`, `jolli-openai-compatible`) and the
 * bare slug is only the AUTH id, so `/provider` deliberately reports those and not it —
 * `httpapi-provider.test.ts` pins
 * that with `expect(body.connected).not.toContain(Brand.short)`. Matching the slug here therefore
 * answered "signed out" to every student on every launch, which is the sign-in gate coming up for
 * somebody who already holds a credential. `dialog-logout.tsx` reads the same helper, which is
 * what "the same signal the TUI uses" was always supposed to mean.
 */
export async function isSignedIn(call: SidecarCall) {
  const providers = await call<{ connected?: string[] }>("/provider", { timeoutMs: PROVIDER_TIMEOUT_MS })
  return isJolliConnected(providers?.connected ?? [])
}

/** Forgets the credential and the catalogue snapshot that belongs to it. */
export async function signOut(call: SidecarCall) {
  await call(`/auth/${Brand.short}`, { method: "DELETE" })
  writeLog("jolli-auth", "signed out")
}

/**
 * Make the server reassemble its config against the credential that just changed.
 *
 * ⚠ IT IS NOT A RESTART, AND IT USED TO HAVE TO BE. The credential travelled in the sidecar's
 * environment, which is read once at fork, so the only way to change it was to replace the process.
 * Now the server reads the database; what is stale after a sign-in is the instance config, and
 * disposing it is what the TUI already does for the same reason.
 *
 * ⚠ ALL OF THEM, NOT THE DEFAULT ONE — WHICH IS WHERE THE DESKTOP PARTS COMPANY WITH THE TUI. The
 * TUI is one directory, so `/instance/dispose` is every instance it has. This app can already have
 * a project open when the student signs in, and that instance keeps the config it was assembled
 * with: no Jolli provider, no models, until a restart. The old sidecar replacement refreshed
 * everything by construction, and `/global/dispose` is what still does.
 */
export async function refreshInstance(call: SidecarCall) {
  await call("/global/dispose", { method: "POST" })
}

/**
 * Bring the app back to the front once the browser hands control back.
 *
 * Best-effort by nature: the OS decides whether a background process may take the foreground, and
 * Windows in particular may only flash the taskbar. The browser tab says sign-in succeeded either
 * way, so a window that does not raise is a blemish rather than a broken flow.
 */
function raiseWindow() {
  if (process.platform === "darwin") app.focus({ steal: true })
  const win = getLastFocusedWindow()
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}
