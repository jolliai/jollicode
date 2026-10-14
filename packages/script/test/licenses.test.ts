import { afterAll, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { modulesPlugin } from "../src/bundle-modules"
import { Licenses } from "../src/licenses"

const dirs: string[] = []
afterAll(() => Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true }))))

async function tempDir() {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "licenses-")))
  dirs.push(dir)
  return dir
}

// Lays out packages the way Bun's isolated installer does: each package lives at
// node_modules/.bun/<name>@<version>/node_modules/<name>, its dependencies are siblings there, and
// the root node_modules links to the top-level ones.
async function fixture(
  packages: { name: string; version: string; files?: Record<string, string>; manifest?: object; root?: boolean }[],
) {
  const dir = await tempDir()
  const store = (pkg: { name: string; version: string }) =>
    path.join(dir, "node_modules/.bun", `${pkg.name.replace("/", "+")}@${pkg.version}`, "node_modules", pkg.name)
  for (const pkg of packages) {
    await Bun.write(
      path.join(store(pkg), "package.json"),
      JSON.stringify({ name: pkg.name, version: pkg.version, ...pkg.manifest }),
    )
    for (const [file, content] of Object.entries(pkg.files ?? {})) await Bun.write(path.join(store(pkg), file), content)
    if (pkg.root === false) continue
    await fs.mkdir(path.dirname(path.join(dir, "node_modules", pkg.name)), { recursive: true })
    // A junction on Windows, where a directory symlink needs admin rights or Developer Mode.
    await fs.symlink(store(pkg), path.join(dir, "node_modules", pkg.name), "junction")
  }
  return { dir, store }
}

describe("packageRoots", () => {
  test("maps bundled files to the package that owns them", () => {
    const roots = Licenses.packageRoots([
      "/repo/node_modules/.bun/effect@4.0.0/node_modules/effect/dist/Schema.js",
      "/repo/node_modules/.bun/effect@4.0.0/node_modules/effect/dist/index.js",
      "/repo/node_modules/.bun/@opentui+core@0.4.5/node_modules/@opentui/core/assets/zig/tree-sitter-zig.wasm",
    ])
    expect([...roots]).toEqual([
      "/repo/node_modules/.bun/effect@4.0.0/node_modules/effect",
      "/repo/node_modules/.bun/@opentui+core@0.4.5/node_modules/@opentui/core",
    ])
  })

  test("uses the innermost node_modules for nested installs", () => {
    expect([...Licenses.packageRoots(["/repo/node_modules/a/node_modules/b/index.js"])]).toEqual([
      "/repo/node_modules/a/node_modules/b",
    ])
  })

  test("drops workspace sources, which NOTICE covers", () => {
    expect(Licenses.packageRoots(["/repo/packages/core/src/brand.ts", "/repo/packages/app/dist/index.js"]).size).toBe(0)
  })

  test("accepts Rollup virtual ids and Windows paths", () => {
    const roots = Licenses.packageRoots([
      "\0/repo/node_modules/.bun/fuzzysort@3.1.0/node_modules/fuzzysort/fuzzysort.js?commonjs-module",
      "C:\\repo\\node_modules\\.bun\\katex@0.16.27\\node_modules\\katex\\dist\\katex.js",
      "\0commonjsHelpers.js",
    ])
    expect([...roots]).toEqual([
      "/repo/node_modules/.bun/fuzzysort@3.1.0/node_modules/fuzzysort",
      "C:/repo/node_modules/.bun/katex@0.16.27/node_modules/katex",
    ])
  })

  test("accepts relative paths and drops paths that name no file inside a package", () => {
    const roots = Licenses.packageRoots([
      "node_modules/foo/index.js",
      "/repo/node_modules/@scope",
      "/repo/node_modules/@scope/",
      "/repo/node_modules/lib",
      "/repo/node_modules/.bin/tool",
      "/repo/node_modules/.bun/lib@1.0.0/node_modules/.bin/tool",
    ])
    expect([...roots]).toEqual(["node_modules/foo"])
  })
})

describe("manifest", () => {
  test("reads license metadata and every license or notice file, once per name@version", async () => {
    const { store } = await fixture([
      {
        name: "@scope/lib",
        version: "1.0.0",
        manifest: { license: "Apache-2.0" },
        files: {
          LICENSE: "Apache License text",
          "NOTICE.txt": "Upstream notice",
          "license.js": "module.exports = 'not a license'",
        },
      },
    ])
    const pkg = { name: "@scope/lib", version: "1.0.0" }
    const packages = await Licenses.manifest([store(pkg), store(pkg)])
    expect(packages).toEqual([
      {
        name: "@scope/lib",
        version: "1.0.0",
        license: "Apache-2.0",
        texts: [
          { file: "LICENSE", content: "Apache License text" },
          { file: "NOTICE.txt", content: "Upstream notice" },
        ],
      },
    ])
  })

  test("keeps third-party notice files alongside the license", async () => {
    const files = [
      "COPYRIGHT",
      "CopyrightNotice.txt",
      "License.txt",
      "LICENSES.md",
      "MIT-LICENSE",
      "THIRD-PARTY-NOTICES.md",
      "ThirdPartyNoticeText.txt",
      "thirdpartynotices.txt",
    ]
    const { store } = await fixture([
      {
        name: "vendored",
        version: "1.0.0",
        manifest: { license: "MIT" },
        files: Object.fromEntries(
          [...files, "third-party.js", "noticeboard.md", "LICENSE.bak", "LICENSE.orig", "LICENSE~"].map((file) => [
            file,
            file,
          ]),
        ),
      },
    ])
    const [pkg] = await Licenses.manifest([store({ name: "vendored", version: "1.0.0" })])
    expect(pkg.texts.map((text) => text.file)).toEqual(files.toSorted())
  })

  test("normalizes legacy license fields", async () => {
    const { store } = await fixture([
      { name: "object", version: "1.0.0", manifest: { license: { type: "MIT" } } },
      { name: "array", version: "1.0.0", manifest: { licenses: [{ type: "MIT" }, { type: "Apache-2.0" }] } },
    ])
    const packages = await Licenses.manifest([
      store({ name: "object", version: "1.0.0" }),
      store({ name: "array", version: "1.0.0" }),
    ])
    expect(packages.map((pkg) => pkg.license)).toEqual(["MIT OR Apache-2.0", "MIT"])
  })

  test("fails on a package that declares no license", async () => {
    const { store } = await fixture([{ name: "mystery", version: "0.1.0" }])
    await expect(Licenses.manifest([store({ name: "mystery", version: "0.1.0" })])).rejects.toThrow(
      "mystery@0.1.0: (none declared)",
    )
  })

  describe("license policy", () => {
    const check = async (license: string) => {
      const { store } = await fixture([{ name: "pkg", version: "1.0.0", manifest: { license } }])
      return Licenses.manifest([store({ name: "pkg", version: "1.0.0" })]).then(
        () => true,
        () => false,
      )
    }

    test.each([
      "MIT",
      "apache-2.0",
      "(MPL-2.0 OR Apache-2.0)",
      "MIT AND ISC",
      "Apache-2.0 WITH LLVM-exception",
      "(Apache-2.0 WITH LLVM-exception)",
    ])("allows %p", async (license) => {
      expect(await check(license)).toBe(true)
    })

    test.each([
      "MPL-2.0",
      "GPL-3.0-only",
      "MIT AND GPL-3.0-only",
      "(MIT OR GPL-3.0-only) AND GPL-2.0-only",
      "SEE LICENSE IN LICENSE.md",
      "UNLICENSED",
    ])("rejects %p", async (license) => {
      expect(await check(license)).toBe(false)
    })
  })

  test("fills in a package whose tarball omits its license from the override list", async () => {
    const { store } = await fixture([{ name: "poe-oauth", version: "0.0.8" }])
    const [pkg] = await Licenses.manifest([store({ name: "poe-oauth", version: "0.0.8" })])
    expect(pkg.license).toBe("MIT")
    expect(pkg.texts[0].content).toContain("Copyright (c) 2026 Poe Platform")
  })
})

describe("dependencyRoots", () => {
  test("follows production dependencies and every installed optional one", async () => {
    const { dir, store } = await fixture([
      {
        name: "a",
        version: "1.0.0",
        manifest: { dependencies: { b: "1.0.0" }, devDependencies: { dev: "1.0.0" } },
      },
      { name: "b", version: "1.0.0", root: false },
      { name: "dev", version: "1.0.0" },
      { name: "native-darwin", version: "1.0.0", manifest: { os: ["darwin"], cpu: ["arm64"] } },
      { name: "native-linux", version: "1.0.0", manifest: { os: ["linux"] } },
    ])
    // b is reachable only from a's own store directory, like Bun's isolated layout.
    await fs.symlink(
      store({ name: "b", version: "1.0.0" }),
      path.join(path.dirname(store({ name: "a", version: "1.0.0" })), "b"),
    )
    await Bun.write(
      path.join(dir, "package.json"),
      JSON.stringify({
        dependencies: { a: "1.0.0" },
        optionalDependencies: { "native-darwin": "1.0.0", "native-linux": "1.0.0", "not-installed": "1.0.0" },
      }),
    )
    const roots = await Licenses.dependencyRoots(dir)
    expect(roots.sort()).toEqual(
      ["a", "b", "native-darwin", "native-linux"].map((name) => store({ name, version: "1.0.0" })).sort(),
    )
  })

  test("fails when a required dependency is not installed", async () => {
    const { dir } = await fixture([])
    await Bun.write(path.join(dir, "package.json"), JSON.stringify({ dependencies: { missing: "1.0.0" } }))
    await expect(Licenses.dependencyRoots(dir)).rejects.toThrow("missing (a dependency of")
  })
})

describe("render", () => {
  test("lists each package with its texts, and says when a package ships none", () => {
    const text = Licenses.render(
      [
        { name: "a", version: "1.0.0", license: "MIT", texts: [{ file: "LICENSE", content: "MIT text\n" }] },
        { name: "b", version: "2.0.0", license: "ISC", texts: [] },
      ],
      { product: "Example", preamble: ["Extra line."] },
    )
    expect(text).toStartWith("Example: Third-Party Licenses\n")
    expect(text).toContain("includes the following 2 third-party")
    expect(text).toContain("Extra line.")
    expect(text).toContain("a@1.0.0\nLicense: MIT\n")
    expect(text).toContain("----- LICENSE -----\n\nMIT text\n")
    expect(text).toContain("b@2.0.0\nLicense: ISC\n" + "=".repeat(80) + "\n\nThis package ships no license file")
  })
})

describe("recorded modules", () => {
  test("round-trips the list modulesPlugin and recordModules write", async () => {
    const dir = await tempDir()
    const emitted: { fileName: string; source: string }[] = []
    const plugin = modulesPlugin()
    plugin.configResolved({ root: dir })
    plugin.generateBundle.call({ emitFile: (file) => (emitted.push(file), file.fileName) }, undefined, {
      "index.js": { type: "chunk", modules: { "/repo/node_modules/a/index.js": {}, "\0virtual": {} } },
      "font.woff2": { type: "asset", originalFileNames: ["node_modules/b/font.woff2"] },
    })
    await Bun.write(path.join(dir, emitted[0].fileName), emitted[0].source)
    expect(await Licenses.recordedModules(dir)).toEqual(
      ["/repo/node_modules/a/index.js", path.join(dir, "node_modules/b/font.woff2"), "\0virtual"].toSorted(),
    )
  })

  test("fails on a missing or empty list rather than shrinking the manifest", async () => {
    const dir = await tempDir()
    await expect(Licenses.recordedModules(dir)).rejects.toThrow("is missing")
    await Licenses.recordModules(dir, [])
    await expect(Licenses.recordedModules(dir)).rejects.toThrow("lists no modules")
  })
})

describe("bunRuntime", () => {
  test("has license notices vendored for the Bun running the build", async () => {
    const bun = await Licenses.bunRuntime()
    expect(bun).toMatchObject({ name: "bun", version: Bun.version, license: "MIT" })
    expect(bun.texts[0].content).toContain("JavaScriptCore")
  })
})
