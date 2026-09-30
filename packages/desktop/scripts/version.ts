#!/usr/bin/env bun
import { $ } from "bun"

// Desktop versions are independent of the CLI and continue from the highest published
// desktop-v* tag in the desktop releases repo.
const TAG_PREFIX = "desktop-v"
const DESKTOP_TAG = /^desktop-v\d+\.\d+\.\d+$/

export type Release = { tagName: string; isDraft: boolean; isPrerelease: boolean }

export function latestDesktopTag(releases: Release[]) {
  return releases
    .filter((item) => !item.isDraft && !item.isPrerelease && DESKTOP_TAG.test(item.tagName))
    .map((item) => item.tagName)
    .sort((a, b) => Bun.semver.order(stripPrefix(b), stripPrefix(a)))[0]
}

export function nextDesktopVersion(input: { latestTag?: string; bump: string; override?: string }) {
  const latest = input.latestTag ? requireVersion(stripPrefix(input.latestTag)) : "0.0.0"
  if (input.override) return requireNewer(requireVersion(stripPrefix(input.override)), latest)
  const [major, minor, patch] = latest.split(".").map(Number)
  if (input.bump === "major") return `${major + 1}.0.0`
  if (input.bump === "minor") return `${major}.${minor + 1}.0`
  if (input.bump === "patch") return `${major}.${minor}.${patch + 1}`
  throw new Error(`Unknown bump "${input.bump}"; expected major, minor, or patch`)
}

export function shouldReuseRelease(tag: string, release: { isDraft: boolean } | undefined) {
  if (!release) return false
  if (!release.isDraft) throw new Error(`${tag} is already published; pass a newer version`)
  return true
}

// The workflow serializes desktop releases, so any other desktop draft was left by an earlier failed run.
export function staleDesktopDrafts(releases: Release[], tag: string) {
  return releases
    .filter((item) => item.isDraft && item.tagName !== tag && DESKTOP_TAG.test(item.tagName))
    .map((item) => item.tagName)
}

function stripPrefix(value: string) {
  return value.replace(/^(desktop-)?v/, "")
}

// Prod clients set allowDowngrade, so publishing a lower version as Latest would roll every install back.
function requireNewer(version: string, latest: string) {
  if (Bun.semver.order(version, latest) <= 0)
    throw new Error(`${version} is not newer than the latest desktop release ${latest}`)
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

  const version = nextDesktopVersion({
    latestTag: latestDesktopTag(releases),
    bump: process.env.DESKTOP_BUMP || "patch",
    override: process.env.DESKTOP_VERSION || undefined,
  })
  const tag = `${TAG_PREFIX}${version}`

  const sha = process.env.GITHUB_SHA ?? (await $`git rev-parse HEAD`.text()).trim()
  const notes = `Built from jolliai/jollicode@${sha}`
  // A reused draft may come from an older commit, so its notes are refreshed to the commit being built.
  if (
    shouldReuseRelease(
      tag,
      releases.find((item) => item.tagName === tag),
    )
  )
    await $`gh release edit ${tag} --notes ${notes} --repo ${repo}`
  if (!releases.some((item) => item.tagName === tag))
    await $`gh release create ${tag} -d --title ${`Jolli Code Desktop ${version}`} --notes ${notes} --repo ${repo}`
  await Promise.all(
    staleDesktopDrafts(releases, tag).map((stale) => $`gh release delete ${stale} --yes --repo ${repo}`),
  )

  const output = [`version=${version}`, `tag=${tag}`, `repo=${repo}`].join("\n")
  console.log(output)
  if (process.env.GITHUB_OUTPUT) await Bun.write(process.env.GITHUB_OUTPUT, output)
}
