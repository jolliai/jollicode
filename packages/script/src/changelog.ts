#!/usr/bin/env bun

// Each product (CLI, desktop, VS Code extension) keeps a CHANGELOG.md whose top `## MAJOR.MINOR.PATCH`
// section is the next release. The release workflows publish that version with that section as notes,
// so the changelog is the only place a release version is chosen.

import { appendFileSync } from "node:fs"

const HEADING = /^## (.*)$/
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const VERSION = /^\d+\.\d+\.\d+$/

export function releaseEntry(text: string, file = "CHANGELOG.md") {
  const lines = text.split(/\r?\n/)
  // The top release is the first two "## " headings outside fenced code; a "## " line inside a fence
  // is example text. As in CommonMark, a fence closes only on the same character, at least as long,
  // with nothing after it.
  let start: number | undefined
  let end: number | undefined
  let fence: string | undefined
  for (const [i, line] of lines.entries()) {
    const match = line.match(FENCE)
    if (fence) {
      if (match && match[1][0] === fence[0] && match[1].length >= fence.length && !match[2].trim()) fence = undefined
      continue
    }
    if (match) {
      fence = match[1]
      continue
    }
    if (!HEADING.test(line)) continue
    if (start === undefined) start = i
    else {
      end = i
      break
    }
  }
  if (start === undefined) throw new Error(`${file} has no "## MAJOR.MINOR.PATCH" section; add one for this release`)
  const version = lines[start].match(HEADING)![1].trim()
  if (!VERSION.test(version)) throw new Error(`${file}: the top heading "## ${version}" is not "## MAJOR.MINOR.PATCH"`)
  const notes = lines
    .slice(start + 1, end)
    .join("\n")
    .trim()
  if (!notes) throw new Error(`${file}: the ${version} section is empty`)
  return { version, notes }
}

// Prints the release version for workflows, and writes its notes to a file when one is given:
//   bun packages/script/src/changelog.ts <CHANGELOG.md> [notes-out]
if (import.meta.main) {
  const [file, out] = process.argv.slice(2)
  if (!file) throw new Error("usage: bun packages/script/src/changelog.ts <CHANGELOG.md> [notes-out]")
  const entry = releaseEntry(await Bun.file(file).text(), file)
  if (out) await Bun.write(out, entry.notes + "\n")
  const output = [`version=${entry.version}`, ...(out ? [`notes=${out}`] : [])].join("\n")
  console.log(output)
  // Append, as GitHub documents for step outputs, so earlier writes in the same step survive.
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output + "\n")
}
