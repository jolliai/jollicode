import { randomUUID } from "node:crypto"
import { mkdirSync, rmSync } from "node:fs"
import * as http from "node:http"
import { createServer } from "node:net"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { getCACertificates, setDefaultCACertificates } from "node:tls"
import type { Event } from "electron"
import { app, BrowserWindow } from "electron"

import { Deferred, Effect, Fiber } from "effect"
import contextMenu from "electron-context-menu"

import { Brand } from "@opencode-ai/app/brand"
import { env } from "@opencode-ai/core/flag/flag"
import type { ServerReadyData } from "../preload/types"
import { isSignedIn, refreshInstance, signIn, signOut } from "./jolli-auth"
import { sidecarCall } from "./jolli-sidecar"
import { checkCourseGate } from "./jolli-course-gate"
import { checkAppExists, resolveAppPath } from "./apps"
import { CHANNEL } from "./constants"
import { registerIpcHandlers, sendDeepLinks, sendMenuCommand } from "./ipc"
import { forwardInitializationFailure } from "./initialization"
import { exportDebugLogs, initCrashReporter, initLogging, startNetLog, write as writeLog } from "./logging"
import { createMenu } from "./menu"
import {
  finishFirstLaunchOnboarding,
  initializeOldLayoutEligibility,
  isFirstLaunchOnboardingPending,
  isOldLayoutEligible,
} from "./onboarding"
import {
  getDefaultServerUrl,
  preferAppEnv,
  setDefaultServerUrl,
  setSidecarDatabase,
  spawnLocalServer,
  type SidecarListener,
} from "./server"
import { awaitSidecarReady } from "./sidecar-health"
import { setupAutoUpdater, showUpdaterDialog } from "./updater"
import { safeWebContentsURL } from "./window-state"
import {
  getLastFocusedWindow,
  registerRendererProtocol,
  setRelaunchHandler,
  setAppQuitting,
  setBackgroundColor,
  setDockIcon,
  restoreMainWindows,
} from "./windows"
import { createWslServersController } from "./wsl/servers"
import { registerWslIpcHandlers } from "./wsl/ipc"
import { spawnWslSidecar } from "./wsl/sidecar"
import { cleanupStoreFiles } from "./store-cleanup"
import { startBackgroundCli } from "./background-cli"
import { setNativeTranslations } from "./native-translations"

const APP_NAMES: Record<string, string> = {
  dev: "Jolli Code Dev",
  beta: "Jolli Code Beta",
  prod: "Jolli Code",
}
// Keep in sync with APP_IDS in ../../electron-builder.config.ts.
const APP_IDS: Record<string, string> = {
  dev: `${Brand.appId}.dev`,
  beta: `${Brand.appId}.beta`,
  prod: Brand.appId,
}
/** Matches the first-launch health wait in the loading task below. */
const SIDECAR_RESTART_HEALTH_TIMEOUT = 30_000
const TEST_ONBOARDING = process.env.OPENCODE_TEST_ONBOARDING === "1"
const SIDECAR_VERSION = process.env.OPENCODE_SIDECAR_V2 === "1" ? "v2" : "v1"
const jsCallStackFeature = "DocumentPolicyIncludeJSCallStacksInCrashReports"

let logger: ReturnType<typeof initLogging>
let server: SidecarListener | null = null
let sidecarAddress: { hostname: string; port: number; password: string } | null = null

/** Authenticated access to our own sidecar, or undefined before it has started. */
const jolliSidecar = () => (sidecarAddress ? sidecarCall(sidecarAddress) : undefined)

const pendingDeepLinks: string[] = []

function useEnvProxy() {
  try {
    // Electron 41.2 runs Node 24.14.1; latest @types/node@24 is 24.12.2.
    ;(http as any).setGlobalProxyFromEnv()
  } catch (error) {
    logger.warn("failed to load proxy environment", error)
  }
}

function emitDeepLinks(urls: string[]) {
  if (urls.length === 0) return
  pendingDeepLinks.push(...urls)
  const win = getLastFocusedWindow()
  if (win) sendDeepLinks(win, urls)
}

async function killSidecar() {
  if (!server) return
  const current = server
  server = null
  await current.stop()
}

/**
 * Spawns the local sidecar and remembers how, so it can be replaced later on the same address.
 *
 * The renderer learns the server's URL and password exactly once (`serverReady`), so a restart has
 * to come back up on the same host, port and password — otherwise every open window would be left
 * talking to a server that no longer exists.
 */
async function startSidecar(hostname: string, port: number, password: string) {
  sidecarAddress = { hostname, port, password }
  const spawned = await spawnLocalServer(hostname, port, password, {
    userDataPath: app.getPath("userData"),
    onStdout: (message) => writeLog("server", "stdout", { message }),
    onStderr: (message) => writeLog("server", "stderr", { message }, "warn"),
    onExit: (code) => writeLog("utility", "sidecar exited", { code }, "warn"),
  })
  server = spawned.listener
  return spawned
}

/**
 * Replaces a running sidecar so it picks up config that only reaches it through its spawn env, and
 * reports whether it came back.
 *
 * ⚠ THE ANSWER IS RETURNED RATHER THAN THROWN OR LOGGED, BECAUSE A DEAD SERVER IS NOT A FAILED
 * SIGN-IN. The credential is already stored by the time this runs, so rejecting would send the
 * student back through the browser to fix something the browser has nothing to do with — and a log
 * line alone is how a renderer left talking to a dead sidecar used to look like a success.
 * `awaitSidecarReady` says why the wait is bounded and why it never throws.
 */
async function restartSidecar() {
  if (!sidecarAddress) return true
  const address = sidecarAddress
  await killSidecar()
  const { health } = await startSidecar(address.hostname, address.port, address.password)
  const result = await awaitSidecarReady(health.wait, SIDECAR_RESTART_HEALTH_TIMEOUT)
  if (!result.ready) logger.error("sidecar did not come back healthy after restart", result.error)
  return result.ready
}

function ensureLoopbackNoProxy() {
  const loopback = ["127.0.0.1", "localhost", "::1"]
  const upsert = (key: string) => {
    const items = (process.env[key] ?? "")
      .split(",")
      .map((value: string) => value.trim())
      .filter((value: string) => Boolean(value))

    for (const host of loopback) {
      if (items.some((value: string) => value.toLowerCase() === host)) continue
      items.push(host)
    }

    process.env[key] = items.join(",")
  }

  upsert("NO_PROXY")
  upsert("no_proxy")
}

const main = Effect.gen(function* () {
  contextMenu({ showSaveImageAs: true, showLookUpSelection: false, showSearchWithGoogle: false })

  // on macOS apps run in `/` which can cause issues with ripgrep
  try {
    process.chdir(homedir())
  } catch {}

  process.env.JOLLICODE_DISABLE_EMBEDDED_WEB_UI = "true"

  const appId = app.isPackaged ? APP_IDS[CHANNEL] : `${Brand.appId}.dev`
  const onboardingTestRoot = ((): string | undefined => {
    if (!TEST_ONBOARDING) return

    const root = join(tmpdir(), `${Brand.bin}-onboarding-${randomUUID()}`)
    rmSync(root, { recursive: true, force: true })
    ;["data", "config", "cache", "state", "desktop", "session"].forEach((dir) =>
      mkdirSync(join(root, dir), { recursive: true }),
    )
    /**
     * ⚠ A FILE, NOT `:memory:`, AND THE CREDENTIAL IS WHY. Two processes each opening `:memory:`
     * get two different databases — which was harmless while the credential travelled separately
     * and is not any more: the onboarding harness would sign in on one side and read nothing on
     * the other.
     *
     * ⚠ AND IT IS HANDED OVER RATHER THAN EXPORTED. `createSidecarEnv()` deletes every `*_DB` it
     * inherits, because the database is the credential store and a student's login shell must not
     * get to pick it; setting `process.env` here would simply be scrubbed back out.
     */
    setSidecarDatabase(join(root, "data", "onboarding.db"))
    process.env.XDG_DATA_HOME = join(root, "data")
    process.env.XDG_CONFIG_HOME = join(root, "config")
    process.env.XDG_CACHE_HOME = join(root, "cache")
    process.env.XDG_STATE_HOME = join(root, "state")
    return root
  })()
  app.setName(app.isPackaged ? APP_NAMES[CHANNEL] : "Jolli Code Dev")
  app.setAppUserModelId(appId)
  app.setPath(
    "userData",
    onboardingTestRoot ? join(onboardingTestRoot, "desktop") : join(app.getPath("appData"), appId),
  )
  if (onboardingTestRoot) app.setPath("sessionData", join(onboardingTestRoot, "session"))
  initializeOldLayoutEligibility(app.getPath("userData"))
  logger = initLogging()
  initCrashReporter()

  const wslServers = createWslServersController(
    app.getVersion(),
    async (distro) => {
      logger.log("spawning wsl sidecar", { distro })
      return spawnWslSidecar(distro, {
        onLine: (line) => logger.log("wsl sidecar", { distro, stream: line.stream, text: line.text }),
      })
    },
    {
      logger: {
        log: (message, meta) => logger.log(message, meta),
        error: (message, meta) => logger.error(message, meta),
      },
    },
  )
  const stopSidecars = async () => {
    await killSidecar()
    wslServers.stopAll()
  }
  const relaunch = () => {
    setAppQuitting()
    void stopSidecars().finally(() => {
      app.relaunch()
      app.quit()
    })
  }

  try {
    setDefaultCACertificates([...new Set([...getCACertificates("default"), ...getCACertificates("system")])])
  } catch (error) {
    logger.warn("failed to load system certificates", error)
  }

  logger.log("app starting", {
    version: app.getVersion(),
    packaged: app.isPackaged,
    onboardingTest: Boolean(onboardingTestRoot),
  })

  ensureLoopbackNoProxy()
  useEnvProxy()
  app.commandLine.appendSwitch("proxy-bypass-list", "<-loopback>")
  const features = app.commandLine.getSwitchValue("enable-features")
  app.commandLine.appendSwitch("enable-features", features ? `${jsCallStackFeature},${features}` : jsCallStackFeature)
  if (!app.isPackaged) app.commandLine.appendSwitch("remote-debugging-port", "9222")

  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  const shellEnv = preferAppEnv(app.getPath("userData"))

  app.on("second-instance", (_event: Event, argv: string[]) => {
    const urls = argv.filter((arg: string) => arg.startsWith(`${Brand.protocol}://`))
    if (urls.length) {
      logger.log("deep link received via second-instance", { urls })
      emitDeepLinks(urls)
    }
    const win = getLastFocusedWindow()
    if (win) {
      win.show()
      win.focus()
    }
  })

  app.on("open-url", (event: Event, url: string) => {
    event.preventDefault()
    logger.log("deep link received via open-url", { url })
    emitDeepLinks([url])
  })

  app.on("before-quit", () => {
    setAppQuitting()
    void stopSidecars()
  })

  app.on("will-quit", () => {
    setAppQuitting()
    void stopSidecars()
  })

  app.on("child-process-gone", (_event, details) => {
    writeLog("utility", "child process gone", { details }, "error")
  })

  app.on("render-process-gone", (_event, webContents, details) => {
    writeLog("window", "app render process gone", { url: safeWebContentsURL(webContents), details }, "error")
  })

  setRelaunchHandler(() => {
    relaunch()
  })

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      setAppQuitting()
      void stopSidecars().finally(() => app.quit())
    })
  }

  const serverReady = Deferred.makeUnsafe<ServerReadyData, unknown>()

  yield* Effect.promise(() => app.whenReady())

  yield* Effect.promise(() => cleanupStoreFiles(app.getPath("userData"))).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        if (result.deleted.length === 0) return
        logger.log("cleaned scoped store files", { count: result.deleted.length, scanned: result.scanned })
      }),
    ),
    Effect.catch((error) =>
      Effect.sync(() => {
        logger.warn("failed to clean scoped store files", error)
      }),
    ),
  )
  /**
   * ⚠ AN UNPACKAGED BUILD HAS TO NAME THE EXECUTABLE AND THE SCRIPT. Windows registers the command
   * line verbatim, and in development that is Electron plus this entry point — without the extra
   * arguments the OS would register bare `electron.exe` and the link would open an empty shell.
   */
  if (app.isPackaged) app.setAsDefaultProtocolClient(Brand.protocol)
  else app.setAsDefaultProtocolClient(Brand.protocol, process.execPath, [resolve(process.argv[1] ?? "")])
  registerRendererProtocol()
  setDockIcon()
  const updater = setupAutoUpdater(stopSidecars)
  const menuDeps = {
    trigger: (id: string) => {
      const win = getLastFocusedWindow()
      if (win) sendMenuCommand(win, id)
    },
    checkForUpdates: () => void showUpdaterDialog(updater, true),
    relaunch,
  }
  registerIpcHandlers({
    killSidecar: () => killSidecar(),
    relaunch,
    awaitInitialization: Effect.fnUntraced(
      function* () {
        logger.log("awaiting server ready")
        const res = yield* Deferred.await(serverReady)
        logger.log("server ready", { url: res.url })
        return res
      },
      (e) => Effect.runPromise(e),
    ),
    consumeInitialDeepLinks: () => pendingDeepLinks.splice(0),
    getDefaultServerUrl: () => getDefaultServerUrl(),
    setDefaultServerUrl: (url) => setDefaultServerUrl(url),
    /**
     * ⚠ EVERY JOLLI ANSWER COMES FROM THE SIDECAR NOW, AND THIS IS WHERE THAT STARTS. The main
     * process holds no credential, so there is nothing here it could answer from — and opening the
     * shared database from Electron would not even reach the same file, because
     * `InstallationChannel` reads a bare global the main bundle does not define.
     *
     * ⚠ NO SERVER YET IS "NO ANSWER", NOT "NO". The renderer is gated on `awaitInitialization`, so
     * in practice the sidecar is up before any of these are called; answering false rather than
     * undefined here would only matter if that gate ever stopped holding, and a signed-in student
     * shown a sign-in screen is the failure that would look like.
     */
    isJolliSignedIn: async () => {
      const call = jolliSidecar()
      if (!call) return false
      return isSignedIn(call).catch(() => false)
    },
    /**
     * ⚠ THE ORDER IS LOAD-BEARING AND MIRRORS THE TUI'S `completeLogin` STEP FOR STEP. Warming the
     * catalogue before disposing the instance is what stops the next config assembly from paying
     * the full `STARTUP_DEADLINE` on a cold cache — the desktop used to warm it before forking the
     * sidecar, and deleting that without replacing it would have been a regression nobody would
     * have noticed until a student watched a splash screen.
     */
    jolliSignIn: async () => {
      const call = jolliSidecar()
      if (!call) return { serverReady: false, courses: "unreachable" as const }
      await signIn(call)
      const courses = (await checkCourseGate(call)).kind
      await refreshInstance(call)
      /**
       * ⚠ THE SERVER WAS NEVER REPLACED, SO IT IS READY BY CONSTRUCTION. This used to report
       * whether a restarted sidecar came back healthy; the credential no longer travels in its
       * environment, so what needed refreshing was the instance config, not the process.
       */
      return { serverReady: true, courses }
    },
    jolliCourseGate: () => checkCourseGate(jolliSidecar()),
    /**
     * ⚠ THE SERVER DROPS THE CATALOGUE SNAPSHOT WITH THE CREDENTIAL. Its filename is keyed to the
     * credential, so nothing will ever read this student's snapshot again — but it is still their
     * course list sitting in a directory the next person to sign in on this machine can read, and
     * the button that reaches here is literally "use a different account".
     */
    jolliSignOut: async () => {
      const call = jolliSidecar()
      if (!call) return
      await signOut(call)
      await refreshInstance(call)
    },
    isFirstLaunchOnboardingPending,
    finishFirstLaunchOnboarding,
    isOldLayoutEligible,
    getDisplayBackend: async () => null,
    setDisplayBackend: async () => undefined,
    checkAppExists: (appName) => checkAppExists(appName),
    resolveAppPath: async (appName) => resolveAppPath(appName),
    updater,
    showUpdater: () => showUpdaterDialog(updater, true),
    setBackgroundColor: (color) => setBackgroundColor(color),
    exportDebugLogs: () => exportDebugLogs(),
    recordFatalRendererError: (error) => writeLog("renderer", "fatal renderer error", { ...error }, "error"),
    setNativeTranslations: (bundle) => {
      if (setNativeTranslations(bundle)) createMenu(menuDeps)
    },
  })
  registerWslIpcHandlers(wslServers)
  void updater.start()
  const updateTimer = setInterval(() => void updater.check(), 10 * 60 * 1000)
  updateTimer.unref()
  app.once("will-quit", () => clearInterval(updateTimer))
  yield* Effect.promise(() => startNetLog()).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        logger.warn("failed to start net log", error)
      }),
    ),
  )

  const loadingTask = yield* Effect.gen(function* () {
    logger.log("sidecar connection started", { version: SIDECAR_VERSION })

    ensureLoopbackNoProxy()
    useEnvProxy()

    if (SIDECAR_VERSION === "v2") {
      logger.log("spawning v2 sidecar")
      const sidecar = yield* Effect.promise(() => startBackgroundCli(logger, shellEnv?.XDG_STATE_HOME))
      yield* Deferred.succeed(serverReady, {
        url: sidecar.url,
        username: sidecar.username,
        password: sidecar.password,
      })

      if (process.platform === "win32") {
        void wslServers.initialize().catch((error) => logger.error("wsl server initialization failed", error))
      }

      logger.log("loading task finished")
      return
    }

    const port = yield* Effect.gen(function* () {
      const fromEnv = env("PORT")
      if (fromEnv) {
        const parsed = Number.parseInt(fromEnv, 10)
        if (!Number.isNaN(parsed)) return parsed
      }

      const res = yield* Deferred.make<number, unknown>()
      const socket = createServer()
      socket.on("error", (e) => Deferred.failSync(res, () => e))
      socket.listen(0, "127.0.0.1", () => {
        const address = socket.address()
        if (typeof address !== "object" || !address) {
          socket.close()
          Deferred.failSync(res, () => new Error("Failed to get port"))
          return
        }
        const port = address.port
        socket.close(() => Effect.runSync(Deferred.succeed(res, port)))
      })

      return yield* Deferred.await(res)
    })
    const hostname = "127.0.0.1"
    const url = `http://${hostname}:${port}`
    const password = randomUUID()

    logger.log("spawning sidecar", { url })
    const { health } = yield* Effect.promise(() => startSidecar(hostname, port, password))
    yield* Deferred.succeed(serverReady, {
      url,
      username: Brand.short,
      password,
    })

    if (process.platform === "win32") {
      void wslServers.initialize().catch((error) => logger.error("wsl server initialization failed", error))
    }

    yield* Effect.promise(() => health.wait).pipe(
      Effect.timeout("30 seconds"),
      Effect.catch((e) =>
        Effect.sync(() => {
          logger.error("sidecar health check failed", e.toString())
        }),
      ),
    )

    logger.log("loading task finished")
  }).pipe(forwardInitializationFailure(serverReady), Effect.forkChild)

  yield* Fiber.await(loadingTask)

  app.on("window-all-closed", () => {
    if (process.platform === "darwin") return
    app.quit()
  })
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length > 0) return
    restoreMainWindows()
  })

  const windows = restoreMainWindows()
  if (windows.length) createMenu(menuDeps)
})

Effect.runFork(main)
