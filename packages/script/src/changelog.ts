#!/usr/bin/env bun

// Each product (CLI, desktop, VS Code extension) keeps a CHANGELOG.md whose top `## MAJOR.MINOR.PATCH`
// section is the next release. The release workflows publish that version with that section as notes,
// so the changelog is the only place a release version is chosen.

const HEADING = /^## (.*)$/
const FENCE = /^\s*(```|~~~)/
const VERSION = /^\d+\.\d+\.\d+$/

export function releaseEntry(text: string, file = "CHANGELOG.md") {
  const lines = text.split(/\r?\n/)
  // A "## " line inside a fenced code block is example text, not a release heading.
  let fence: string | undefined
  const headings = lines.flatMap((line, i) => {
    const marker = line.match(FENCE)?.[1]
    if (marker && (!fence || marker === fence)) fence = fence ? undefined : marker
    else if (!fence && HEADING.test(line)) return [i]
    return []
  })
  const [start, end] = headings
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
  if (process.env.GITHUB_OUTPUT) await Bun.write(process.env.GITHUB_OUTPUT, output + "\n")
}
