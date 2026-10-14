#!/usr/bin/env bun
import { rm } from "fs/promises"
import path from "path"
import { BUN_LICENSE_DIR } from "./licenses"

// Vendors Bun's LICENSE.md for the Bun running this script, replacing any older version's copy.
// Run it after bumping `packageManager` in the root package.json.
const url = `https://raw.githubusercontent.com/oven-sh/bun/bun-v${Bun.version}/LICENSE.md`
const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
if (!response.ok) throw new Error(`Could not fetch ${url}: HTTP ${response.status}`)
const stale = await Array.fromAsync(new Bun.Glob("bun-*-LICENSE.md").scan({ cwd: BUN_LICENSE_DIR }))
await Promise.all(stale.map((file) => rm(path.join(BUN_LICENSE_DIR, file))))
const file = path.join(BUN_LICENSE_DIR, `bun-${Bun.version}-LICENSE.md`)
await Bun.write(file, await response.text())
console.log(`Wrote ${path.relative(process.cwd(), file)}`)
