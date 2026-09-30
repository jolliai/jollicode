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
  if (input.override) return requireVersion(stripPrefix(input.override))
  const [major, minor, patch] = (input.latestTag ? requireVersion(stripPrefix(input.latestTag)) : "0.0.0")
    .split(".")
    .map(Number)
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

function stripPrefix(value: string) {
  return value.replace(/^(desktop-)?v/, "")
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

  if (!shouldReuseRelease(tag, releases.find((item) => item.tagName === tag))) {
    const sha = process.env.GITHUB_SHA ?? (await $`git rev-parse HEAD`.text()).trim()
    await $`gh release create ${tag} -d --title ${`Jolli Code Desktop ${version}`} --notes ${`Built from jolliai/jollicode@${sha}`} --repo ${repo}`
  }

  const output = [`version=${version}`, `tag=${tag}`, `repo=${repo}`].join("\n")
  console.log(output)
  if (process.env.GITHUB_OUTPUT) await Bun.write(process.env.GITHUB_OUTPUT, output)
}
