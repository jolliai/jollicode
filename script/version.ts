#!/usr/bin/env bun

import { Script } from "@opencode-ai/script"
// The repo root does not depend on @opencode-ai/core, so this imports brand.ts by path. It has no
// dependencies of its own, which makes that safe.
import { Brand } from "../packages/core/src/brand"
import { $ } from "bun"
import { appendFileSync } from "node:fs"

type Release = { id: number; tag_name: string; draft: boolean }

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

  const notesFile = process.env.RELEASE_NOTES_FILE
  if (!notesFile) throw new Error("RELEASE_NOTES_FILE is required")

  // A run that failed after this job leaves a draft for the same tag. Drafts create no git ref, so
  // GitHub would accept a second one and later lookups by tag would be ambiguous; reuse the draft
  // instead, pointed at this commit with the current notes, as the desktop release does.
  // --paginate concatenates one JSON array per page, so emit one release per line instead.
  const list = async () =>
    (
      await $`gh api ${`repos/${process.env.GH_REPO}/releases?per_page=100`} --paginate --jq ${".[] | {id, tag_name, draft}"}`.text()
    )
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Release)
  const existing = (await list()).find((item) => item.tag_name === Script.tag)
  if (existing && !existing.draft) throw new Error(`${Script.tag} is already published`)
  // Both calls return the release itself: the release list can lag a draft that was just created. The
  // PATCH resends tag_name because GitHub renames a draft to untagged-<hash> when an edit omits it, and
  // the later `gh release upload` and `gh release edit` calls look the draft up by tag.
  const release: Release = existing
    ? await $`gh api -X PATCH repos/${process.env.GH_REPO}/releases/${existing.id} -f tag_name=${Script.tag} -f target_commitish=${sha} -F body=@${notesFile}`.json()
    : await $`gh api -X POST repos/${process.env.GH_REPO}/releases -f tag_name=${Script.tag} -f target_commitish=${sha} -f name=${`Jolli Code CLI ${Script.version}`} -F draft=true -F body=@${notesFile}`.json()
  if (release.tag_name !== Script.tag)
    throw new Error(`${Script.tag} draft came back tagged ${release.tag_name}; check its tag on GitHub`)
  output.push(`release=${release.id}`)
  output.push(`tag=${release.tag_name}`)
}

output.push(`repo=${process.env.GH_REPO}`)

// Append, as GitHub documents for step outputs, so earlier writes in the same step survive.
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output.join("\n") + "\n")

process.exit(0)
