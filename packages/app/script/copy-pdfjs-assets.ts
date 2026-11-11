/**
 * Copies pdf.js's static data into `public/assets/pdfjs/<pdf.js version>/`, where the PDF viewer
 * points pdf.js at it.
 *
 * ⚠ Copied UNRENAMED, and that is why this is a script rather than an import. pdf.js takes each of
 * these as a base URL and appends the original file names to it (`cMapUrl` + `UniGB-UCS2-H.bcmap`),
 * which Vite's hashed asset names cannot satisfy.
 *
 * ⚠ Under `assets/`, not beside it: the production image copies only `index.html` and `assets/`
 * out of the build, and serves `/assets` with a year-long cache. The version in the path is what
 * makes that cache safe — a new pdf.js gets a new directory rather than an old font.
 *
 * What each directory is for:
 * - `cmaps/` — character maps. Without them a Chinese PDF whose font is not embedded draws boxes.
 * - `standard_fonts/` — the base-14 fonts a PDF may name without embedding.
 * - `wasm/` — the JPEG 2000 and JBIG2 decoders scanned handouts use, and the colour-management one.
 *   `quickjs-eval.*` is left out: it runs a PDF's own JavaScript, which the viewer never enables.
 * - `iccs/` — colour profiles for CMYK images.
 *
 * The output is gitignored and rebuilt by the web and desktop build hooks. Every run starts from an empty
 * `pdfjs/`, so a directory left by an older pdf.js never ships.
 */

import { cpSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"

const PDFJS_DIRECTORIES = ["cmaps", "standard_fonts", "wasm", "iccs"] as const
const OMITTED = /^quickjs-eval\./

function print(msg: string): void {
  process.stdout.write(`${msg}\n`)
}

/** Resolves once the copy is done; the desktop prebuild and predev scripts await it before their next step. */
export async function copyPdfjsAssets() {
  const require = createRequire(import.meta.url)
  const packageDir = dirname(require.resolve("pdfjs-dist/package.json"))
  const metadata: unknown = await Bun.file(join(packageDir, "package.json")).json()
  if (!metadata || typeof metadata !== "object" || !("version" in metadata) || typeof metadata.version !== "string")
    throw new Error("Invalid pdf.js package metadata")
  const version = metadata.version
  const outputRoot = join(import.meta.dirname, "..", "public", "assets", "pdfjs")
  const output = join(outputRoot, version)

  rmSync(outputRoot, { recursive: true, force: true })
  for (const directory of PDFJS_DIRECTORIES) {
    cpSync(join(packageDir, directory), join(output, directory), {
      recursive: true,
      filter: (source) => !OMITTED.test(source.split(/[\\/]/).pop() ?? ""),
    })
  }
  print(`Copied pdf.js ${version} assets to ${output}`)
}

if (import.meta.main) await copyPdfjsAssets()
