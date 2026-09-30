#!/usr/bin/env bun

// Each product (CLI, desktop, VS Code extension) keeps a CHANGELOG.md whose top `## MAJOR.MINOR.PATCH`
// section is the next release. The release workflows publish that version with that section as notes,
// so the changelog is the only place a release version is chosen.

const HEADING = /^## (.*)$/
const VERSION = /^\d+\.\d+\.\d+$/

export function releaseEntry(text: string, file = "CHANGELOG.md") {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => HEADING.test(line))
  if (start === -1) throw new Error(`${file} has no "## MAJOR.MINOR.PATCH" section; add one for this release`)
  const version = lines[start].match(HEADING)![1].trim()
  if (!VERSION.test(version)) throw new Error(`${file}: the top heading "## ${version}" is not "## MAJOR.MINOR.PATCH"`)
  const end = lines.findIndex((line, i) => i > start && HEADING.test(line))
  const notes = lines
    .slice(start + 1, end === -1 ? undefined : end)
    .join("\n")
    .trim()
  if (!notes) throw new Error(`${file}: the ${version} section is empty`)
  return { version, notes }
}

// Prints the release version and writes its notes to a file, for workflows to pass on:
//   bun packages/script/src/changelog.ts <CHANGELOG.md> <notes-out>
if (import.meta.main) {
  const [file, out] = process.argv.slice(2)
  if (!file || !out) throw new Error("usage: bun packages/script/src/changelog.ts <CHANGELOG.md> <notes-out>")
  const entry = releaseEntry(await Bun.file(file).text(), file)
  await Bun.write(out, entry.notes + "\n")
  const output = [`version=${entry.version}`, `notes=${out}`].join("\n")
  console.log(output)
  if (process.env.GITHUB_OUTPUT) await Bun.write(process.env.GITHUB_OUTPUT, output + "\n")
}
