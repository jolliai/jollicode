import { nativeT } from "../native-translations"

export function wslServerIdsToStartOnInitialize(servers: { id: string }[]) {
  return servers.map((server) => server.id)
}

export function expectOpencodeVersion(installed: string | null, expected: string, distro = "Debian") {
  if (installed === expected) return
  throw new Error(
    nativeT("desktop.wsl.error.updateVersion", {
      distro,
      installed: installed ?? nativeT("desktop.wsl.error.noVersion"),
      expected,
    }),
  )
}

// The desktop pins the CLI that was current when it was built, but CLI releases ship on their own
// schedule. A distro the user upgraded past the pin is fine; offering an update would roll it back.
export function cliSatisfiesPin(installed: string, pinned: string) {
  const parse = (value: string) =>
    value
      .match(/^v?(\d+)\.(\d+)\.(\d+)/)
      ?.slice(1)
      .map(Number)
  const have = parse(installed)
  const want = parse(pinned)
  if (!have || !want) return installed === pinned
  const diff = have.map((part, i) => part - want[i]).find((part) => part !== 0) ?? 0
  return diff >= 0
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
