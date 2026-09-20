/**
 * SIGNING THE STUDENT IN TO JOLLI FROM THE MAIN PROCESS.
 *
 * ⚠ IT IS THE SAME FLOW THE BARE CLI RUNS. `startJolliLogin` binds the loopback callback and
 * redeems the one-time code; the main process is Node, so nothing here needs a second
 * implementation. What is desktop-specific is opening the browser, pulling the window back to the
 * front afterwards, and where the credentials are kept.
 *
 * ⚠ NO CUSTOM-SCHEME CALLBACK. `jollicode://` is registered as a deep link for opening projects,
 * but Jolli's callback allowlist admits only the loopback URL — a custom scheme is claimable by any
 * application on the machine. Routing sign-in through the deep link would need that allowlist
 * changed first.
 */
import { app, safeStorage } from "electron"
import { startJolliLogin } from "@opencode-ai/core/jolli/loopback"
import { getStore } from "./store"
import { JOLLI_AUTH_TOKEN_KEY, JOLLI_BASE_URL_KEY } from "./store-keys"
import { write as writeLog } from "./logging"
import { getLastFocusedWindow, openExternalURL } from "./windows"

export interface JolliSession {
  readonly token: string
  readonly baseUrl?: string
}

/**
 * This run's session, held so a machine that cannot encrypt still works until it quits. On every
 * other machine this is just a cache of what the store already holds.
 */
let session: JolliSession | undefined

/** Runs the browser sign-in end to end and persists the result. Throws with a readable message. */
export async function signIn(): Promise<JolliSession> {
  const attempt = await startJolliLogin({ clientVersion: app.getVersion() })
  writeLog("jolli-auth", "sign-in started")
  openExternalURL(attempt.url)

  const credentials = await attempt.wait()
  store(credentials)
  raiseWindow()
  writeLog("jolli-auth", "sign-in completed", { hasBaseUrl: !!credentials.baseUrl })
  return credentials
}

/** The stored session, or undefined when signed out or the stored token can't be read back. */
export function currentSession(): JolliSession | undefined {
  if (session) return session

  const stored = getStore().get(JOLLI_AUTH_TOKEN_KEY)
  if (typeof stored !== "string" || stored.length === 0) return undefined

  const token = decrypt(stored)
  if (!token) return undefined

  const baseUrl = getStore().get(JOLLI_BASE_URL_KEY)
  session = { token, ...(typeof baseUrl === "string" && baseUrl ? { baseUrl } : {}) }
  return session
}

export function signOut() {
  session = undefined
  getStore().delete(JOLLI_AUTH_TOKEN_KEY)
  getStore().delete(JOLLI_BASE_URL_KEY)
}

function store(credentials: JolliSession) {
  session = credentials
  getStore().set(JOLLI_AUTH_TOKEN_KEY, encrypt(credentials.token))
  if (credentials.baseUrl) getStore().set(JOLLI_BASE_URL_KEY, credentials.baseUrl)
  else getStore().delete(JOLLI_BASE_URL_KEY)
}

/**
 * ⚠ THE STORE FILE IS PLAINTEXT JSON, SO THE TOKEN IS ENCRYPTED BEFORE IT GOES IN. `safeStorage`
 * binds the ciphertext to the OS keychain (Keychain, DPAPI, libsecret), which is the only at-rest
 * protection this app has — nothing else it persists is a credential.
 *
 * ⚠ WHEN THE OS CANNOT ENCRYPT, WE REFUSE TO PERSIST RATHER THAN FALL BACK TO PLAINTEXT. Some Linux
 * desktops ship no keyring, and `safeStorage` reports that honestly. Writing the student's bearer
 * token to a world-readable JSON file there would trade a visible failure for an invisible one; the
 * session stays in memory instead and the next launch asks them to sign in again.
 */
function encrypt(token: string) {
  if (!safeStorage.isEncryptionAvailable()) {
    writeLog("jolli-auth", "OS encryption unavailable; not persisting the Jolli token", {}, "warn")
    return ""
  }
  return safeStorage.encryptString(token).toString("base64")
}

function decrypt(stored: string) {
  if (!safeStorage.isEncryptionAvailable()) return undefined
  // A keychain the user reset, or a store copied between machines, yields ciphertext this install
  // cannot open. That is a signed-out state, not a crash.
  try {
    return safeStorage.decryptString(Buffer.from(stored, "base64"))
  } catch (error) {
    writeLog("jolli-auth", "stored Jolli token could not be decrypted; treating as signed out", { error }, "warn")
    return undefined
  }
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
