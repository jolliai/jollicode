import { $ } from "bun"
import { chmod, copyFile } from "node:fs/promises"
import { join } from "node:path"

export type Channel = "dev" | "beta" | "prod"

export function resolveChannel(): Channel {
  const raw = Bun.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
}

// `dist` is the directory `packages/cli/script/build.ts` emits for that target, and what its
// `--only` flag selects.
export const CLI_BINARIES: Array<{ rustTarget: string; dist: string; os: string }> = [
  {
    rustTarget: "aarch64-apple-darwin",
    dist: "cli-darwin-arm64",
    os: "darwin",
  },
  {
    rustTarget: "x86_64-apple-darwin",
    dist: "cli-darwin-x64-baseline",
    os: "darwin",
  },
  {
    rustTarget: "aarch64-pc-windows-msvc",
    dist: "cli-windows-arm64",
    os: "win32",
  },
  {
    rustTarget: "x86_64-pc-windows-msvc",
    dist: "cli-windows-x64-baseline",
    os: "win32",
  },
  {
    rustTarget: "x86_64-unknown-linux-gnu",
    dist: "cli-linux-x64-baseline",
    os: "linux",
  },
  {
    rustTarget: "aarch64-unknown-linux-gnu",
    dist: "cli-linux-arm64",
    os: "linux",
  },
]

export const RUST_TARGET = Bun.env.RUST_TARGET

function nativeTarget() {
  const { platform, arch } = process
  if (platform === "darwin") return arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin"
  if (platform === "win32") return arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc"
  if (platform === "linux") return arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu"
  throw new Error(`Unsupported platform: ${platform}/${arch}`)
}

export function getCurrentCli(target = RUST_TARGET ?? nativeTarget()) {
  const binaryConfig = CLI_BINARIES.find((item) => item.rustTarget === target)
  if (!binaryConfig) throw new Error(`CLI configuration not available for target '${target}'`)

  return binaryConfig
}

export async function buildCliToResources() {
  const cli = getCurrentCli()
  // Build from this repo rather than installing a published tarball: the bundled daemon has to
  // match the server and command surface this checkout ships, and the platform packages are not
  // published from here. `--only` selects the target even when it is not the host's.
  const dest = windowsify("resources/jollicode-cli")
  await $`bun script/build.ts ${`--only=${cli.dist}`}`.cwd("../cli")
  await copyFile(join("../cli/dist", cli.dist, "bin", cli.os === "win32" ? "lildax.exe" : "lildax"), dest)
  if (process.platform !== "win32") await chmod(dest, 0o755)
  if (process.platform === "win32" && process.env.GITHUB_ACTIONS === "true") {
    await $`pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File ../../script/sign-windows.ps1 ${dest}`
  }
  if (process.platform === "darwin") await $`codesign --force --sign - ${dest}`

  console.log(`Built ${cli.dist} to ${dest}`)
}

export function windowsify(path: string) {
  if (path.endsWith(".exe")) return path
  return `${path}${process.platform === "win32" ? ".exe" : ""}`
}
