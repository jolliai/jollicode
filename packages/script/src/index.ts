import { $ } from "bun"
import semver from "semver"
import path from "path"
import { Brand } from "@opencode-ai/core/brand"

const rootPkgPath = path.resolve(import.meta.dir, "../../../package.json")
const rootPkg = await Bun.file(rootPkgPath).json()
const expectedBunVersion = rootPkg.packageManager?.split("@")[1]

if (!expectedBunVersion) {
  throw new Error("packageManager field not found in root package.json")
}

// relax version requirement
const expectedBunVersionRange = `^${expectedBunVersion}`

if (!semver.satisfies(process.versions.bun, expectedBunVersionRange)) {
  throw new Error(`This script requires bun@${expectedBunVersionRange}, but you are using bun@${process.versions.bun}`)
}

const env = {
  OPENCODE_CHANNEL: process.env["OPENCODE_CHANNEL"],
  OPENCODE_VERSION: normalizeVersion(process.env["OPENCODE_VERSION"]),
  OPENCODE_RELEASE: process.env["OPENCODE_RELEASE"],
}
const CHANNEL = await (async () => {
  if (env.OPENCODE_CHANNEL) return env.OPENCODE_CHANNEL
  if (env.OPENCODE_VERSION && !env.OPENCODE_VERSION.startsWith("0.0.0-")) return "latest"
  return await $`git branch --show-current`.text().then((x) => x.trim())
})()
const IS_PREVIEW = CHANNEL !== "latest"

const VERSION = await (async () => {
  if (env.OPENCODE_VERSION) return env.OPENCODE_VERSION
  if (IS_PREVIEW) return `0.0.0-${CHANNEL}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`
  // Release versions come from the top section of packages/opencode/CHANGELOG.md, which the publish
  // workflow passes in as OPENCODE_VERSION.
  throw new Error(`the ${CHANNEL} channel needs OPENCODE_VERSION`)
})()

const bot = ["actions-user", "jollicode", "jolli-agent[bot]"]
const team = [...bot]

export const Script = {
  get channel() {
    return CHANNEL
  },
  get version() {
    return VERSION
  },
  // CLI releases use their own tag prefix; desktop releases are tagged desktop-v* separately.
  get tag() {
    return `cli-v${VERSION}`
  },
  get preview() {
    return IS_PREVIEW
  },
  get release(): boolean {
    return !!env.OPENCODE_RELEASE
  },
  get team() {
    return team
  },
}
console.log(`${Brand.bin} script`, JSON.stringify(Script, null, 2))

// Accept a version copied from a release tag (cli-v1.2.3, v1.2.3) and reject anything that would
// produce a malformed tag or npm version.
function normalizeVersion(value: string | undefined) {
  if (!value) return value
  const version = value.replace(/^(cli-)?v/, "")
  if (!semver.valid(version)) throw new Error(`OPENCODE_VERSION "${value}" is not a valid semver version`)
  return version
}
