#!/usr/bin/env bun
import { $ } from "bun"
import { appendFileSync } from "node:fs"
import { Brand } from "@opencode-ai/core/brand"

// Desktop versions are independent of the CLI. The version is the top "## MAJOR.MINOR.PATCH" section of
// packages/desktop/CHANGELOG.md, and it must be newer than the highest published desktop-v* tag.
const TAG_PREFIX = "desktop-v"
const DESKTOP_TAG = /^desktop-v\d+\.\d+\.\d+$/

export type Release = { tagName: string; isDraft: boolean; isPrerelease: boolean }

export function latestDesktopTag(releases: Release[]) {
  return releases
    .filter((item) => !item.isDraft && !item.isPrerelease && DESKTOP_TAG.test(item.tagName))
    .map((item) => item.tagName)
    .sort((a, b) => Bun.semver.order(stripPrefix(b), stripPrefix(a)))[0]
}

export function releaseVersion(input: { version: string; latestTag?: string }) {
  const latest = input.latestTag ? requireVersion(stripPrefix(input.latestTag)) : "0.0.0"
  return requireNewer(requireVersion(input.version), latest)
}

export function shouldReuseRelease(tag: string, release: { isDraft: boolean } | undefined) {
  if (!release) return false
  if (!release.isDraft)
    throw new Error(`${tag} is already published; add a newer section to packages/desktop/CHANGELOG.md`)
  return true
}

// The workflow serializes desktop releases, so any other desktop draft was left by an earlier failed run.
export function staleDesktopDrafts(releases: Release[], tag: string) {
  return releases
    .filter((item) => item.isDraft && item.tagName !== tag && DESKTOP_TAG.test(item.tagName))
    .map((item) => item.tagName)
}

// The Windows WSL installer runs a published CLI release, so each desktop build pins the CLI that is
// current on npm when it is built. The npm placeholder 0.0.0 means no CLI has been released yet.
export function requireCliVersion(value: string) {
  const version = value.trim()
  if (!/^\d+\.\d+\.\d+$/.test(version) || version === "0.0.0")
    throw new Error(`npm has no real ${Brand.npm} release ("${version}"); publish the CLI first`)
  return version
}

function stripPrefix(value: string) {
  return value.replace(/^(desktop-)?v/, "")
}

// Prod clients set allowDowngrade, so publishing a lower version as Latest would roll every install back.
function requireNewer(version: string, latest: string) {
  if (Bun.semver.order(version, latest) <= 0)
    throw new Error(
      `packages/desktop/CHANGELOG.md names ${version}, which is not newer than the latest desktop release ${latest}; add a section for the new release`,
    )
  return version
}

function requireVersion(value: string) {
  if (!/^\d+\.\d+\.\d+$/.test(value)) throw new Error(`"${value}" is not a MAJOR.MINOR.PATCH version`)
  return value
}

if (import.meta.main) {
  const repo = process.env.GH_REPO
  if (!repo) throw new Error("GH_REPO is required")

  // `gh release list` exits non-zero for an unreachable repo. `gh release view` would report that
  // as "release not found" and silently restart the version line at 0.0.1.
  const releases: Release[] =
    await $`gh release list --repo ${repo} --json tagName,isDraft,isPrerelease --limit 1000`.json()

  const changelogVersion = process.env.DESKTOP_VERSION
  if (!changelogVersion) throw new Error("DESKTOP_VERSION is required")
  const notesFile = process.env.RELEASE_NOTES_FILE
  if (!notesFile) throw new Error("RELEASE_NOTES_FILE is required")
  const version = releaseVersion({ version: changelogVersion, latestTag: latestDesktopTag(releases) })
  const tag = `${TAG_PREFIX}${version}`

  const cliVersion = requireCliVersion(await $`npm view ${Brand.npm} version`.text())

  const sha = process.env.GITHUB_SHA ?? (await $`git rev-parse HEAD`.text()).trim()
  // The workflow's sign_windows escape hatch ships unsigned Windows installers; the release page says so.
  const unsigned =
    process.env.DESKTOP_SIGN_WINDOWS === "false"
      ? [
          "**The Windows installers in this release are not code-signed.** Windows shows an unknown publisher warning when installing.",
        ]
      : []
  const notes = [
    (await Bun.file(notesFile).text()).trim(),
    ...unsigned,
    "---",
    `Built from jolliai/jollicode@${sha}`,
    `WSL installs CLI cli-v${cliVersion}`,
  ].join("\n\n")
  // A reused draft may come from an older commit, so its notes are refreshed to the commit being built.
  const existing = releases.find((item) => item.tagName === tag)
  await (shouldReuseRelease(tag, existing)
    ? $`gh release edit ${tag} --notes ${notes} --repo ${repo}`
    : $`gh release create ${tag} -d --title ${`Jolli Code Desktop ${version}`} --notes ${notes} --repo ${repo}`)
  await Promise.all(
    staleDesktopDrafts(releases, tag).map((stale) => $`gh release delete ${stale} --yes --repo ${repo}`),
  )

  const output = [`version=${version}`, `tag=${tag}`, `repo=${repo}`, `cli_version=${cliVersion}`].join("\n")
  console.log(output)
  // Append, as GitHub documents for step outputs, so earlier writes in the same step survive.
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output + "\n")
}
