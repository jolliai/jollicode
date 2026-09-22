import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { app, utilityProcess } from "electron"
import type { Details } from "electron"
import { getLogger } from "./logging"
import { getUserShell, loadShellEnv } from "./shell-env"
import { getStore } from "./store"
import { clearCourseSkills, GATEWAY_URL, jolliGatewayConfig } from "./jolli-gateway"
import { DEFAULT_SERVER_URL_KEY } from "./store-keys"
import { Brand } from "@opencode-ai/app/brand"

export type HealthCheck = { wait: Promise<void> }

type SidecarMessage =
  { type: "ready" } | { type: "stopped" } | { type: "error"; error: { message: string; stack?: string } }

export type SidecarListener = { stop: () => Promise<void> }

const SIDECAR_SERVICE_NAME = "opencode server"
const SIDECAR_START_STALL_TIMEOUT = 60_000
const SIDECAR_STOP_TIMEOUT = 6_000

type SpawnLocalServerOptions = {
  userDataPath: string
  onStdout?: (message: string) => void
  onStderr?: (message: string) => void
  onExit?: (code: number) => void
}

export function getDefaultServerUrl(): string | null {
  const value = getStore().get(DEFAULT_SERVER_URL_KEY)
  return typeof value === "string" ? value : null
}

export function setDefaultServerUrl(url: string | null) {
  if (url) {
    getStore().set(DEFAULT_SERVER_URL_KEY, url)
    return
  }

  getStore().delete(DEFAULT_SERVER_URL_KEY)
}

export function preferAppEnv(userDataPath: string) {
  const shell = process.platform === "win32" ? null : getUserShell()
  const shellEnv = shell ? loadShellEnv(shell, getLogger()) : null
  Object.assign(process.env, {
    ...shellEnv,
    OPENCODE_EXPERIMENTAL_ICON_DISCOVERY: "true",
    OPENCODE_EXPERIMENTAL_FILEWATCHER: "true",
    OPENCODE_CLIENT: "desktop",
    XDG_STATE_HOME: process.env.XDG_STATE_HOME ?? userDataPath,
  })
  return shellEnv
}

export async function spawnLocalServer(
  hostname: string,
  port: number,
  password: string,
  options: SpawnLocalServerOptions,
) {
  const sidecar = join(dirname(fileURLToPath(import.meta.url)), "sidecar.js")
  const child = utilityProcess.fork(sidecar, [], {
    cwd: process.cwd(),
    env: await createSidecarEnv(),
    serviceName: SIDECAR_SERVICE_NAME,
    stdio: "pipe",
  })
  let exited = false
  const exit = defer<number>()

  const onProcessGone = (_event: unknown, details: Details) => {
    if (details.type !== "Utility" || details.name !== SIDECAR_SERVICE_NAME) return
    options.onStderr?.(`utility process gone reason=${details.reason} exitCode=${details.exitCode}`)
  }

  app.on("child-process-gone", onProcessGone)
  child.once("exit", (code) => {
    exited = true
    app.off("child-process-gone", onProcessGone)
    options.onExit?.(code)
    exit.resolve(code)
  })
  child.on("error", (error) => options.onStderr?.(`utility process error: ${serializeError(error).message}`))

  child.stdout?.on("data", (chunk: Buffer) => options.onStdout?.(chunk.toString("utf8").trimEnd()))
  child.stderr?.on("data", (chunk: Buffer) => options.onStderr?.(chunk.toString("utf8").trimEnd()))

  await new Promise<void>((resolve, reject) => {
    let done = false
    let timeout: NodeJS.Timeout

    const fail = (error: Error) => {
      if (done) return
      done = true
      cleanup()
      reject(error)
    }

    const refreshTimeout = () => {
      clearTimeout(timeout)
      timeout = setTimeout(() => {
        fail(new Error(`Sidecar did not become ready within ${SIDECAR_START_STALL_TIMEOUT}ms: ${sidecar}`))
      }, SIDECAR_START_STALL_TIMEOUT)
    }

    const onMessage = (message: SidecarMessage) => {
      if (message.type === "ready") {
        if (done) return
        done = true
        cleanup()
        resolve()
        return
      }
      if (message.type === "error") {
        fail(Object.assign(new Error(message.error.message), { stack: message.error.stack }))
      }
    }
    const onExit = (code: number) => {
      fail(new Error(`Sidecar exited before ready with code ${code}`))
    }
    const cleanup = () => {
      clearTimeout(timeout)
      child.off("message", onMessage)
      child.off("exit", onExit)
    }

    child.on("message", onMessage)
    child.on("exit", onExit)
    refreshTimeout()
    child.postMessage({
      type: "start",
      hostname,
      port,
      password,
      userDataPath: options.userDataPath,
    })
  }).catch((error) => {
    if (!exited) child.kill()
    throw error
  })

  const wait = (async () => {
    const url = `http://${hostname}:${port}`
    let healthy = false
    const gone = exit.promise.then((code) => {
      if (healthy) return
      throw new Error(`Sidecar exited before health check passed with code ${code}`)
    })

    const ready = async () => {
      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        if (await checkHealth(url, password)) {
          healthy = true
          return
        }
      }
    }

    await Promise.race([ready(), gone])
  })()

  let stopping: Promise<void> | undefined

  return {
    listener: {
      stop: () => {
        if (stopping) return stopping
        if (exited) return Promise.resolve()
        child.postMessage({ type: "stop" })
        stopping = Promise.race([
          exit.promise.then(() => undefined),
          delay(SIDECAR_STOP_TIMEOUT).then(() => {
            if (!exited) child.kill()
          }),
        ])
        return stopping
      },
    },
    health: { wait },
  }
}

export async function checkHealth(url: string, password?: string | null): Promise<boolean> {
  let healthUrls: URL[]
  try {
    healthUrls = [new URL("/api/health", url), new URL("/global/health", url)]
  } catch {
    return false
  }

  const headers = new Headers()
  if (password) {
    const auth = Buffer.from(`${Brand.short}:${password}`).toString("base64")
    headers.set("authorization", `Basic ${auth}`)
  }

  for (const healthUrl of healthUrls) {
    try {
      const res = await fetch(healthUrl, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(3000),
      })
      if (res.ok) return true
    } catch {}
  }
  return false
}

/**
 * The database the sidecar must open, when this process has chosen one. Undefined in every shipped
 * configuration; only the onboarding harness sets it. See {@link setSidecarDatabase}.
 */
let sidecarDatabase: string | undefined

/**
 * NAME THE DATABASE THE SIDECAR OPENS, AS THIS PROCESS RATHER THAN AS THE ENVIRONMENT.
 *
 * ⚠ IT IS A CALL RATHER THAN AN ENV VAR BECAUSE THE SCRUB BELOW DELETES EVERY `*_DB` IT IS HANDED,
 * and that scrub is load-bearing: the database is the credential store, so an inherited
 * `JOLLICODE_DB` would let a student's `~/.zshrc` choose which one this app trusts. The onboarding
 * harness needs both processes on one file and cannot get there through the environment any more,
 * so it says so here, where "the desktop app is the only writer of this environment" still holds.
 */
export function setSidecarDatabase(file: string) {
  sidecarDatabase = file
}

/**
 * ⚠ EXPORTED FOR ONE TEST, AND THAT TEST EARNS IT. Two of the lines below are invisible
 * dependencies of the whole Jolli design — the lockdown flags that turn the server's own config
 * floor on, and the scrub list that keeps a student's login shell from deciding which account this
 * app acts as. Nothing else would notice either of them being removed.
 */
export async function createSidecarEnv(): Promise<Record<string, string>> {
  const env = Object.fromEntries(
    Object.entries(process.env).flatMap(([key, value]) => (value === undefined ? [] : [[key, String(value)]])),
  )
  delete env.DEBUG
  if (process.platform === "linux") delete env.LD_PRELOAD
  /**
   * ⚠ SCRUB EVERY CONFIG SURFACE THE STUDENT COULD HAVE EXPORTED — UNDER BOTH PREFIXES — BEFORE WRITING
   * THE GATEWAY CONFIG BELOW. `preferAppEnv` sources the student's login shell (`$SHELL -il`, so
   * `~/.zshrc`) into `process.env`, which is copied into `env` above. The core flag reader resolves each
   * of these by suffix, preferring the canonical `JOLLICODE_` over the legacy `OPENCODE_` alias
   * (`packages/core/src/flag/flag.ts`), so an inherited `JOLLICODE_CONFIG_CONTENT` would shadow the
   * gateway config and re-open bring-your-own-key — the exact inversion the lockdown exists to prevent.
   * The rest are the other ways the same config could be widened: CONFIG/CONFIG_DIR/TUI_CONFIG redirect
   * config loading, PERMISSION widens permissions, MODELS_URL/MODELS_PATH swap the catalogue, and
   * PLUGIN_META_FILE loads foreign plugins. Stripping both prefixes is what makes "the desktop app is the
   * only writer of this environment" (below) actually true.
   */
  for (const suffix of [
    "CONFIG_CONTENT",
    "CONFIG",
    "CONFIG_DIR",
    "TUI_CONFIG",
    "PERMISSION",
    "MODELS_URL",
    "MODELS_PATH",
    "PLUGIN_META_FILE",
    /**
     * ⚠ THE DATABASE IS NOW THE CREDENTIAL STORE AND THE LOCKDOWN'S SOURCE OF TRUTH, SO ITS
     * LOCATION IS A CONFIG SURFACE TOO. An inherited `JOLLICODE_DB=/tmp/mine.db` would point the
     * sidecar at a database the student wrote — with whatever credential and whatever tenant they
     * chose. `AUTH_CONTENT` is the same hole one layer up: raw JSON credentials, read before the
     * file is.
     */
    "DB",
    "AUTH_CONTENT",
    /**
     * ⚠ THE GATEWAY IS THE MODEL LOCKDOWN, SO ITS ADDRESS IS A CONFIG SURFACE TOO — AND A SHARPER
     * ONE THAN THE REST. The server exempts a pinned gateway from the origin allowlist and sends
     * the student's credential to it (`plugin/jolli.ts`), which is exactly what a build aimed at a
     * fixture needs and exactly what an inherited `JOLLICODE_GATEWAY_URL` from `~/.zshrc` must not
     * be able to claim. Deleted here and written below from the value baked into this build.
     */
    "GATEWAY_URL",
    /**
     * ⚠ THE CREDENTIAL KEYS ARE SCRUBBED PERMANENTLY, NOT TRANSITIONALLY, AND THE REASON INVERTED.
     * This process used to SET them, so an inherited value had to lose. It no longer sets them —
     * the sidecar reads the credential from the shared database — but `jolli/session.ts` still
     * honours them as the development override `jolli/DEV.md` documents. So an inherited
     * `JOLLICODE_JOLLI_TOKEN` from the student's own `~/.zshrc` would decide which account this
     * server acts as. Deleting both spellings is what keeps that a developer's tool rather than a
     * student's lever; it is not leftover cleanup waiting to be removed.
     */
    "JOLLI_TOKEN",
    "JOLLI_BASE_URL",
  ]) {
    delete env["JOLLICODE_" + suffix]
    delete env["OPENCODE_" + suffix]
  }
  // After the scrub, not before: an inherited value loses and this process's own choice wins.
  if (sidecarDatabase) env["JOLLICODE_DB"] = sidecarDatabase
  /**
   * ⚠ THE BUILD'S GATEWAY, HANDED TO THE PROCESS THAT ACTUALLY DIALS IT. `jolliGatewayConfig()`
   * below already puts it in the config, but the server's strict pass rebuilds that provider block
   * from the credential and overwrites it — so this is what lets that pass rebuild it correctly,
   * and what lets the provider's own `fetch` recognise the pinned address as one the credential
   * belongs at. Unset when this build pinned nothing, which leaves the signed-in tenant deciding.
   */
  if (GATEWAY_URL) env["JOLLICODE_GATEWAY_URL"] = GATEWAY_URL
  /**
   * ⚠ THE COURSE'S MODEL CATALOGUE, HANDED TO THE SERVER THAT OWNS PROVIDERS. See
   * `jolli-gateway.ts` for what it declares and why it is the strongest config layer.
   *
   * ⚠ IT GOES IN THE SIDECAR'S ENVIRONMENT RATHER THAN INTO A FILE, because a file is a thing a
   * student can find and edit, and because the desktop app is the only writer of this environment.
   * A server the app did not spawn — the one a developer runs by hand — will not have it, which is
   * a real difference to remember when reviewing (jolli/DEV.md says how to pass it).
   */
  /**
   * ⚠ STALE COURSE SKILLS ARE CLEARED AT EVERY LAUNCH, and nothing writes any. A build that did
   * write them leaves `SKILL.md` files under `userData` that the server would keep discovering and
   * offering as slash commands no professor authored. It fails soft: a disk error costs the cleanup,
   * not the models, so the lockdown above still holds.
   */
  try {
    clearCourseSkills(app.getPath("userData"))
  } catch (error) {
    getLogger().warn("failed to clear course skills", { error: serializeError(error).message })
  }
  /**
   * ⚠ THIS IS THE LINE THAT TURNS THE SERVER'S OWN JOLLI FLOOR ON, AND WITHOUT IT NOTHING BELOW
   * WORKS. `packages/opencode/src/config/config.ts` gates that floor on `JOLLICODE_LOCKDOWN`, and
   * the flag is set by the CLI entry point — which the sidecar does not go through, because it
   * imports the server module directly. So until this was written the sidecar's bottom config layer
   * was `{}` and `JOLLICODE_CONFIG_CONTENT` was the only thing enforcing anything. Now that the
   * models and the credential come from the server itself, the floor is where they come from.
   *
   * ⚠ THE STRICT FLAG IS THE OTHER HALF, AND ONLY THIS SURFACE SETS IT. It runs a pass after every
   * config layer has merged: no config-supplied `apiKey`, the tenant's own `baseURL`, and no Jolli
   * provider at all while signed out. Layering cannot express any of that, because remeda's
   * `mergeDeep` has no way to remove a key a lower layer set. The bare CLI deliberately keeps its
   * steppable floor, which is why this is a separate flag rather than a stronger `LOCKDOWN`.
   *
   * Both are written under the canonical `JOLLICODE_` prefix — the one the flag reader prefers — so
   * nothing inherited from the student's shell can out-rank them.
   */
  env.JOLLICODE_LOCKDOWN = "1"
  env.JOLLICODE_LOCKDOWN_STRICT = "1"
  /**
   * ⚠ NO CREDENTIAL CROSSES THIS BOUNDARY ANY MORE, AND THAT IS THE POINT OF THE WHOLE CHANGE. The
   * sidecar reads the signed-in student from the database it already shares with the bare CLI, so
   * this process no longer needs to hold a token, no longer needs to decide whether one is fresh,
   * and can build this config before anyone has signed in. What is left here is the ceiling: one
   * provider, one gateway.
   */
  env.JOLLICODE_CONFIG_CONTENT = jolliGatewayConfig()
  return env
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function serializeError(error: unknown) {
  if (error instanceof Error) return { message: error.message, stack: error.stack }
  return { message: String(error) }
}

function defer<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
