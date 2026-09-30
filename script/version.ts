#!/usr/bin/env bun

import { Script } from "@opencode-ai/script"
import { Brand } from "../packages/core/src/brand"
import { $ } from "bun"

const output = [`version=${Script.version}`]
const sha = process.env.GITHUB_SHA ?? (await $`git rev-parse HEAD`.text()).trim()

if (!Script.preview) {
  // The version comes from the top of packages/opencode/CHANGELOG.md. A section that was never bumped
  // still names the last release, so refuse it here rather than fail at npm publish after the draft.
  const res = await fetch(`https://registry.npmjs.org/${Brand.npm}/latest`)
  if (!res.ok && res.status !== 404) throw new Error(`npm registry lookup failed: ${res.status} ${res.statusText}`)
  const latest = res.ok ? ((await res.json()) as { version: string }).version : undefined
  if (latest && Bun.semver.order(Script.version, latest) <= 0)
    throw new Error(
      `packages/opencode/CHANGELOG.md names ${Script.version}, which is not newer than the published ${latest}; add a section for the new release`,
    )

  const notes = process.env.RELEASE_NOTES_FILE
  if (!notes) throw new Error("RELEASE_NOTES_FILE is required")
  await $`gh release create ${Script.tag} -d --target ${sha} --title ${`Jolli Code CLI ${Script.version}`} --notes-file ${notes}`
  const release = await $`gh release view ${Script.tag} --json tagName,databaseId`.json()
  output.push(`release=${release.databaseId}`)
  output.push(`tag=${release.tagName}`)
}

output.push(`repo=${process.env.GH_REPO}`)

if (process.env.GITHUB_OUTPUT) {
  await Bun.write(process.env.GITHUB_OUTPUT, output.join("\n"))
}

process.exit(0)
