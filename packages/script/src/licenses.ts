import fs from "fs/promises"
import path from "path"
import { MODULES_FILE } from "./bundle-modules"

export type Package = {
  name: string
  version: string
  license: string
  texts: { file: string; content: string }[]
}

export const NOTICE_PATH = path.resolve(import.meta.dir, "../../../NOTICE")

// Packages whose published tarball carries no license metadata. Each entry cites its upstream source.
const OVERRIDES: Record<string, { license: string; text: string }> = {
  // https://github.com/poe-platform/poe-code/blob/main/packages/poe-oauth/LICENSE
  "poe-oauth": {
    license: "MIT",
    text: `MIT License

Copyright (c) 2026 Poe Platform

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`,
  },
}

const NODE_MODULES = "/node_modules/"
const RULE = "=".repeat(80)

/**
 * Maps bundled module paths to the npm package roots that own them. Workspace sources are not
 * third-party: the opencode section of NOTICE covers them, so paths outside node_modules are dropped.
 * Accepts Rollup ids too (`\0` virtual prefix, `?query` suffix), Windows separators, and relative
 * paths. Anything that names no file inside a package (a bare `@scope`, `.bin`) is dropped too.
 */
export function packageRoots(modules: Iterable<string>) {
  return new Set(
    [...modules].flatMap((module) => {
      const file = module.replace(/^\0/, "").split("?")[0].replaceAll("\\", "/")
      // Searched with a leading slash so a relative `node_modules/...` path matches too.
      const index = `/${file}`.lastIndexOf(NODE_MODULES)
      if (index === -1) return []
      const start = index + NODE_MODULES.length - 1
      const parts = file.slice(start).split("/")
      const name = parts.slice(0, parts[0].startsWith("@") ? 2 : 1)
      if (parts.length <= name.length || name.some((part) => part === "" || part.startsWith("."))) return []
      return [file.slice(0, start) + name.join("/")]
    }),
  )
}

/** Absolute module paths from a Bun.build metafile, whose input keys are relative to the build's cwd. */
export function metafileModules(metafile: { inputs: Record<string, unknown> } | undefined) {
  if (!metafile) throw new Error("Bun.build was not run with `metafile: true`")
  return Object.keys(metafile.inputs).map((file) => path.resolve(file))
}

/** Records a build's module list in `dir` for a later step (the Desktop packager) to collect. */
export async function recordModules(dir: string, modules: string[]) {
  await Bun.write(path.join(dir, MODULES_FILE), JSON.stringify([...new Set(modules)].sort(), null, 2))
}

/**
 * Reads a list recordModules or modulesPlugin wrote. An empty or missing list fails: either means the
 * recording broke (a bundler upgrade changing the plugin hook's shape, a skipped build step), and
 * would otherwise shrink the manifest silently.
 */
export async function recordedModules(dir: string): Promise<string[]> {
  const file = Bun.file(path.join(dir, MODULES_FILE))
  if (!(await file.exists())) throw new Error(`${file.name} is missing; the build that writes ${dir} records it`)
  const modules: string[] = await file.json()
  if (modules.length === 0) throw new Error(`${file.name} lists no modules; its build recorded nothing`)
  return modules
}

/**
 * Production dependency closure of an installed package directory, for packers that copy
 * node_modules verbatim (electron-builder) rather than bundling. Every installed optional
 * dependency counts whatever its os/cpu: electron-builder's node_modules walk copies them all, so a
 * host with other platforms' natives installed ships those too. A missing required dependency fails
 * rather than shrinking the manifest. peerDependencies are not followed, matching electron-builder's
 * own production-dependency walk: a peer the app needs is a direct dependency somewhere upstream.
 */
export async function dependencyRoots(dir: string) {
  const seen = new Set<string>()
  const visit = async (from: string): Promise<void> => {
    const pkg = await Bun.file(path.join(from, "package.json")).json()
    // Siblings resolve concurrently; `seen` is checked and set with no await between, so each
    // package is still visited once.
    await Promise.all(
      [
        ...Object.keys(pkg.dependencies ?? {}).map((name) => ({ name, optional: false })),
        ...Object.keys(pkg.optionalDependencies ?? {}).map((name) => ({ name, optional: true })),
      ].map(async (dep) => {
        const root = await resolvePackage(dep.name, from)
        if (!root && dep.optional) return
        if (!root) throw new Error(`${dep.name} (a dependency of ${from}) is not installed`)
        if (seen.has(root)) return
        seen.add(root)
        await visit(root)
      }),
    )
  }
  // Absolute, so the upward node_modules walk in resolvePackage has parents to climb.
  await visit(path.resolve(dir))
  return [...seen].filter((root) => root.replaceAll("\\", "/").includes(NODE_MODULES))
}

/**
 * Reads each package's license metadata and files, deduplicated by name@version. Throws when any
 * package declares no license or one outside the policy, so a new dependency cannot ship unreviewed.
 */
export async function manifest(roots: Iterable<string>) {
  const packages = await Promise.all([...new Set(roots)].map(read))
  const unique = [...new Map(packages.map((pkg) => [`${pkg.name}@${pkg.version}`, pkg])).values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  )
  const rejected = unique.filter((pkg) => !allowed(pkg.license))
  if (rejected.length > 0)
    throw new Error(
      [
        "Third-party packages with a missing or disallowed license:",
        ...rejected.map((pkg) => `  ${pkg.name}@${pkg.version}: ${pkg.license || "(none declared)"}`),
        "Review the license, then allow it in packages/script/src/licenses.ts or add an override there.",
      ].join("\n"),
    )
  return unique
}

export const BUN_LICENSE_DIR = path.resolve(import.meta.dir, "../vendor")

/**
 * The Bun runtime that `bun build --compile` embeds in every binary, with Bun's notices for the
 * libraries it statically links (JavaScriptCore/WebKit under LGPL-2, BoringSSL, zlib-ng, ...). npm
 * ships no copy of that file, so it is vendored per Bun version: the Bun running the build is the
 * runtime a compile embeds for every target, and builds stay offline and reproducible.
 */
export async function bunRuntime(): Promise<Package> {
  const file = Bun.file(path.join(BUN_LICENSE_DIR, `bun-${Bun.version}-LICENSE.md`))
  if (!(await file.exists()))
    throw new Error(
      `No vendored license notices for Bun ${Bun.version}. Run \`bun run update-bun-license\` in packages/script.`,
    )
  return {
    name: "bun",
    version: Bun.version,
    license: "MIT",
    texts: [{ file: "LICENSE.md", content: await file.text() }],
  }
}

export function render(packages: Package[], input: { product: string; preamble?: string[] }) {
  return [
    `${input.product}: Third-Party Licenses`,
    "",
    `${input.product} includes the following ${packages.length} third-party open-source packages. Each`,
    "package's license and notice files are reproduced below as distributed with that package.",
    ...(input.preamble ? ["", ...input.preamble] : []),
    "",
    ...packages.flatMap((pkg) => [
      RULE,
      `${pkg.name}@${pkg.version}`,
      `License: ${pkg.license}`,
      RULE,
      "",
      ...(pkg.texts.length > 0
        ? pkg.texts.flatMap((text) => [`----- ${text.file} -----`, "", text.content.trim(), ""])
        : ["This package ships no license file; it is distributed under the license named above.", ""]),
    ]),
  ].join("\n")
}

/** Writes NOTICE and THIRD-PARTY-LICENSES into `dir`, the pair that ships next to each CLI binary. */
export async function write(dir: string, text: string) {
  await Bun.write(path.join(dir, "NOTICE"), Bun.file(NOTICE_PATH))
  await Bun.write(path.join(dir, "THIRD-PARTY-LICENSES"), text)
}

// Permissive licenses reviewed for shipping in a proprietary binary distribution, lowercased. An
// allowlist on purpose: any other license, weak copyleft such as MPL-2.0 on its own included, fails
// the build until someone reviews it and adds it here.
const ALLOWED = new Set([
  "0bsd",
  "apache-2.0",
  "blueoak-1.0.0",
  "bsd-2-clause",
  "bsd-3-clause",
  "cc-by-3.0",
  "cc-by-4.0",
  "cc0-1.0",
  "isc",
  "mit",
  "python-2.0",
])

// `expression` is the SPDX expression from package.json, e.g. "MIT", "(MIT OR Apache-2.0)",
// "MIT AND Zlib", "Apache-2.0 WITH LLVM-exception", or "" when the package declares none.
function allowed(expression: string) {
  // A WITH exception only grants extra permissions, so the base license decides.
  const normalized = expression
    .toLowerCase()
    .replace(/\s+with\s+\S+/g, "")
    .replace(/[()]/g, " ")
    .trim()
  if (normalized === "") return false
  const terms = normalized.split(/\s+(?:and|or)\s+/)
  // A pure OR expression lets us pick any one license. Anything with AND must allow every term,
  // including mixed AND/OR, whose grouping this flat split cannot see: stricter, never looser.
  if (/\s+and\s+/.test(normalized)) return terms.every((term) => ALLOWED.has(term))
  return terms.some((term) => ALLOWED.has(term))
}

async function read(root: string): Promise<Package> {
  const pkg = await Bun.file(path.join(root, "package.json")).json()
  const override = OVERRIDES[pkg.name]
  const files = (await fs.readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && isLicenseFile(entry.name))
    .map((entry) => entry.name)
    .sort()
  const texts = await Promise.all(
    files.map(async (file) => ({ file, content: await Bun.file(path.join(root, file)).text() })),
  )
  return {
    name: pkg.name,
    version: pkg.version,
    license: override?.license ?? licenseField(pkg),
    texts: texts.length === 0 && override ? [{ file: "LICENSE (upstream)", content: override.text }] : texts,
  }
}

// LICENSE, LICENSES.md, LICENSE-MIT, MIT-LICENSE, COPYING, COPYRIGHT, CopyrightNotice.txt,
// NOTICE.txt, and the third-party notice files some packages add for code they vendor:
// thirdpartynotices.txt, THIRD-PARTY-NOTICES.md, ThirdPartyNoticeText.txt.
function isLicenseFile(name: string) {
  return (
    /^(licen[cs]es?|copying|copyright([-_]?notice)?|notices?|mit[-_]licen[cs]e|third[-_]?party[-_]?notices?([-_]?text)?)([-_.].*)?$/i.test(
      name,
    ) && !/(\.(c|m)?(js|ts|json|map|bak|orig|rej|swp)|~)$/i.test(name)
  )
}

function licenseField(pkg: { license?: unknown; licenses?: unknown }) {
  if (typeof pkg.license === "string") return pkg.license
  if (hasType(pkg.license)) return pkg.license.type
  if (Array.isArray(pkg.licenses))
    return pkg.licenses.map((item) => (hasType(item) ? item.type : String(item))).join(" OR ")
  return ""
}

function hasType(value: unknown): value is { type: string } {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string"
}

async function resolvePackage(name: string, from: string): Promise<string | undefined> {
  const candidate = path.join(from, "node_modules", name)
  if (await Bun.file(path.join(candidate, "package.json")).exists()) return fs.realpath(candidate)
  const parent = path.dirname(from)
  if (parent === from) return undefined
  return resolvePackage(name, parent)
}

export * as Licenses from "./licenses"
