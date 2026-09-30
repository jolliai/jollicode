import { nativeT } from "../native-translations"

export function wslServerIdsToStartOnInitialize(servers: { id: string }[]) {
  return servers.map((server) => server.id)
}

// A local build pins no version and installs the latest release, so any version that runs will do.
export function expectOpencodeVersion(installed: string | null, expected: string | undefined, distro = "Debian") {
  if (installed && (!expected || installed === expected)) return
  throw new Error(
    nativeT("desktop.wsl.error.updateVersion", {
      distro,
      installed: installed ?? nativeT("desktop.wsl.error.noVersion"),
      expected: expected ?? "latest",
    }),
  )
}

// The desktop pins the CLI that was current when it was built, but CLI releases ship on their own
// schedule. A distro the user upgraded past the pin within the same major is fine; offering an update
// would roll it back. A different major may change the sidecar API the desktop drives, so it does not
// count, and a pre-release sorts below its release as in semver. Local builds pin nothing and accept
// whatever is installed.
export function cliSatisfiesPin(installed: string, pinned: string | undefined) {
  if (!pinned) return true
  const parse = (value: string) => {
    const match = value.match(/^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?/)
    return match && { core: match.slice(1, 4).map(Number), pre: !!match[4] }
  }
  const have = parse(installed)
  const want = parse(pinned)
  if (!have || !want) return installed === pinned
  if (have.core[0] !== want.core[0]) return false
  const diff = have.core.map((part, i) => part - want.core[i]).find((part) => part !== 0) ?? 0
  if (diff !== 0) return diff > 0
  return !have.pre || want.pre
}

export const pendingRestartAfterWslInstall = (runtime: { available: boolean }) => !runtime.available

export async function pollWslHealth(check: () => Promise<boolean>, signal: AbortSignal, interval = 100) {
  while (!signal.aborted) {
    if (await check()) return
    await abortableDelay(interval, signal)
  }
}

function abortableDelay(duration: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timeout)
      signal.removeEventListener("abort", done)
      resolve()
    }
    const timeout = setTimeout(done, duration)
    signal.addEventListener("abort", done, { once: true })
  })
}
