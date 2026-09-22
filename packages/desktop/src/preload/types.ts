import type { DesktopMenuAction } from "@opencode-ai/app/desktop-menu"
import type { WslServersPlatform } from "@opencode-ai/app/wsl/types"
import type { UpdaterState } from "@opencode-ai/app/updater"
import type { DesktopNativeBundle } from "@opencode-ai/app/i18n/desktop-native"
export type {
  WslDistroProbe,
  WslInstalledDistro,
  WslJob,
  WslOnlineDistro,
  WslOpencodeCheck,
  WslRuntimeCheck,
  WslServerConfig,
  WslServerItem,
  WslServerRuntime,
  WslServersEvent,
  WslServersState,
} from "@opencode-ai/app/wsl/types"

export type ServerReadyData = {
  url: string
  username: string | null
  password: string | null
}

export type WslServersAPI = WslServersPlatform
export type UpdaterAPI = {
  subscribe: (cb: (state: UpdaterState) => void) => Promise<() => void>
  check: () => Promise<UpdaterState>
  install: () => Promise<void>
}

export type LinuxDisplayBackend = "wayland" | "auto"
export type TitlebarTheme = {
  mode: "light" | "dark"
  scheme?: "system" | "light" | "dark"
}
export type FatalRendererError = {
  error: string
  url: string
  version?: string
  platform: string
  os?: string
}

/**
 * Whether this student has a Jolli Code course to work in.
 *
 * ⚠ THREE STATES, NOT A BOOLEAN, BECAUSE TWO OF THEM READ THE SAME AND MEAN OPPOSITE THINGS. "You
 * have no courses" is a message about the student's enrolment and sends them to their instructor;
 * "we could not ask" is a message about the network and sends them to their Wi-Fi. Collapsing them
 * would make the app confidently wrong exactly when it is offline.
 */
export type CourseGateResult = { kind: "ok" | "none" | "unreachable" }

/** What `jolliSignIn` reports back once the credential is stored. */
export type JolliSignInResult = {
  /**
   * Whether the sidecar came back healthy with the new credential. False means the student is
   * signed in but the app has no server to talk to, which a restart fixes and another sign-in does
   * not.
   */
  serverReady: boolean
  /**
   * Whether they have anywhere to work. Checked here rather than through a second round trip
   * because signing in is exactly when it changes, and the fetch behind it had to happen anyway to
   * build the sidecar's config.
   */
  courses: CourseGateResult["kind"]
}

export type ElectronAPI = {
  killSidecar: () => Promise<void>
  installCli: () => Promise<string>
  awaitInitialization: () => Promise<ServerReadyData>
  wslServers: WslServersAPI
  updater: UpdaterAPI
  consumeInitialDeepLinks: () => Promise<string[]>
  getDefaultServerUrl: () => Promise<string | null>
  setDefaultServerUrl: (url: string | null) => Promise<void>
  isJolliSignedIn: () => Promise<boolean>
  /**
   * Re-asks whether the signed-in student has a course. The sign-in result already answers this;
   * this is for the two paths that have no sign-in to ride on — launching already signed in, and
   * the gate's own "check again" button after the student has been added to a course.
   */
  jolliCourseGate: () => Promise<CourseGateResult>
  /**
   * Forgets the stored credential AND replaces the local server, because the server holds a copy
   * of it from when it was forked. Offered from the course gate, where signing in as the wrong
   * account is a real reason to be looking at an empty course list.
   */
  jolliSignOut: () => Promise<void>
  /**
   * Resolves when the browser sign-in completes; rejects with a message worth showing.
   *
   * A resolved sign-in still reports whether the local server survived being restarted with the new
   * credential, because those two can fail independently and only one of them is worth a retry.
   */
  jolliSignIn: () => Promise<JolliSignInResult>
  /**
   * Calls off a sign-in that is still waiting on the browser, closing its loopback callback server.
   *
   * ⚠ NEEDED BECAUSE A CLOSED BROWSER TAB IS INVISIBLE TO THAT SERVER. Nothing arrives when a
   * student abandons the page, so the attempt would otherwise sit there until its five-minute
   * timeout — port bound, callback live, and a `jolliSignIn` promise the screen cannot get out of.
   *
   * The `jolliSignIn` call it cancels rejects; the sign-in screen ignores that, since the student
   * asked for it. Safe to call with nothing pending.
   */
  jolliSignInCancel: () => Promise<void>
  isFirstLaunchOnboardingPending: () => Promise<boolean>
  finishFirstLaunchOnboarding: (createDefaultProject: boolean) => Promise<string | null>
  isOldLayoutEligible: () => Promise<boolean>
  getDisplayBackend: () => Promise<LinuxDisplayBackend | null>
  setDisplayBackend: (backend: LinuxDisplayBackend | null) => Promise<void>
  checkAppExists: (appName: string) => Promise<boolean>
  resolveAppPath: (appName: string) => Promise<string | null>
  storeGet: (name: string, key: string) => Promise<string | null>
  storeSet: (name: string, key: string, value: string) => Promise<void>
  storeDelete: (name: string, key: string) => Promise<void>
  storeClear: (name: string) => Promise<void>
  storeKeys: (name: string) => Promise<string[]>
  storeLength: (name: string) => Promise<number>
  draftGet: (key: string) => Promise<string | null>
  draftSet: (key: string, value: string) => Promise<void>
  draftDelete: (key: string) => Promise<void>
  draftBlobPut: (data: ArrayBuffer) => Promise<string>
  draftBlobGet: (id: string) => Promise<ArrayBuffer | null>

  getWindowID: () => Promise<string>
  onMenuCommand: (cb: (id: string) => void) => () => void
  onDeepLink: (cb: (urls: string[]) => void) => () => void

  openDirectoryPicker: (opts?: {
    multiple?: boolean
    title?: string
    defaultPath?: string
  }) => Promise<string | string[] | null>
  openFilePicker: (opts?: {
    multiple?: boolean
    title?: string
    defaultPath?: string
    extensions?: string[]
  }) => Promise<{ token: string; files: { path: string; name: string; size: number }[] } | null>
  readPickedFile: (token: string, path: string) => Promise<ArrayBuffer>
  releasePickedFiles: (token: string) => Promise<void>
  getPathForFile: (file: File) => string
  saveFilePicker: (opts?: { title?: string; defaultPath?: string }) => Promise<string | null>
  openExternal: (url: string) => void
  openLocalFile: (url: string) => void
  openPath: (path: string, app?: string) => Promise<void>
  revealPath: (path: string) => Promise<boolean>
  readClipboardImage: () => Promise<{ buffer: ArrayBuffer; width: number; height: number } | null>
  getWindowFocused: () => Promise<boolean>
  getWindowFullscreen: () => Promise<boolean>
  onWindowFullscreenChanged: (cb: (fullscreen: boolean) => void) => () => void
  setWindowFocus: () => Promise<void>
  showWindow: () => Promise<void>
  relaunch: () => void
  getZoomFactor: () => Promise<number>
  setZoomFactor: (factor: number) => Promise<void>
  getPinchZoomEnabled: () => Promise<boolean>
  setPinchZoomEnabled: (enabled: boolean) => Promise<void>
  onPinchZoomEnabledChanged: (cb: (enabled: boolean) => void) => () => void
  onZoomFactorChanged: (cb: (factor: number) => void) => () => void
  setTitlebar: (theme: TitlebarTheme) => Promise<void>
  runDesktopMenuAction: (action: DesktopMenuAction) => Promise<void>
  setBackgroundColor: (color: string) => Promise<void>
  exportDebugLogs: () => Promise<string>
  setForceFocus: (enabled: boolean) => Promise<void>
  recordFatalRendererError: (error: FatalRendererError) => Promise<void>
  setNativeTranslations: (bundle: DesktopNativeBundle) => Promise<void>
}
