#!/usr/bin/env bun

import { $ } from "bun"
import path from "path"
import { fileURLToPath } from "url"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

const generated = await import("./generate.ts")

import { Script } from "@opencode-ai/script"
import { Licenses } from "@opencode-ai/script/licenses"
import { MODULES_FILE } from "@opencode-ai/script/bundle-modules"
import { Brand } from "@opencode-ai/core/brand"
import pkg from "../package.json"

const singleFlag = process.argv.includes("--single")
const baselineFlag = process.argv.includes("--baseline")
const skipInstall = process.argv.includes("--skip-install")
const sourcemapsFlag = process.argv.includes("--sourcemaps")
const plugin = createSolidTransformPlugin()
const skipEmbedWebUi = process.argv.includes("--skip-embed-web-ui")

const appDir = path.join(import.meta.dirname, "../../app")

const createEmbeddedWebUIBundle = async () => {
  console.log(`Building Web UI to embed in the binary`)
  const dist = path.join(appDir, "dist")
  await $`OPENCODE_CHANNEL=${Script.channel} OPENCODE_RECORD_MODULES=1 bun run --cwd ${appDir} build`
  const files = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: dist })))
    .map((file) => file.replaceAll("\\", "/"))
    // MODULES_FILE lists build-machine paths; it feeds the license manifest and must not be served.
    .filter((file) => !file.endsWith(".map") && !file.endsWith(MODULES_FILE))
    .sort()
  const imports = files.map((file, i) => {
    const spec = path.relative(dir, path.join(dist, file)).replaceAll("\\", "/")
    return `import file_${i} from ${JSON.stringify(spec.startsWith(".") ? spec : `./${spec}`)} with { type: "file" };`
  })
  const entries = files.map((file, i) => `  ${JSON.stringify(file)}: file_${i},`)
  return [
    `// Import all files as file_$i with type: "file"`,
    ...imports,
    `// Export with original mappings`,
    `export default {`,
    ...entries,
    `}`,
  ].join("\n")
}

const embeddedFileMap = skipEmbedWebUi ? null : await createEmbeddedWebUIBundle()
const treeSitterWorker = await Bun.file(fileURLToPath(import.meta.resolve("@opentui/core/parser.worker"))).text()

const allTargets: {
  os: string
  arch: "arm64" | "x64"
  abi?: "musl"
  avx2?: false
}[] = [
  {
    os: "linux",
    arch: "arm64",
  },
  {
    os: "linux",
    arch: "x64",
  },
  {
    os: "linux",
    arch: "x64",
    avx2: false,
  },
  {
    os: "linux",
    arch: "arm64",
    abi: "musl",
  },
  {
    os: "linux",
    arch: "x64",
    abi: "musl",
  },
  {
    os: "linux",
    arch: "x64",
    abi: "musl",
    avx2: false,
  },
  {
    os: "darwin",
    arch: "arm64",
  },
  {
    os: "darwin",
    arch: "x64",
  },
  {
    os: "darwin",
    arch: "x64",
    avx2: false,
  },
  {
    os: "win32",
    arch: "arm64",
  },
  {
    os: "win32",
    arch: "x64",
  },
  {
    os: "win32",
    arch: "x64",
    avx2: false,
  },
]

const targets = singleFlag
  ? allTargets.filter((item) => {
      if (item.os !== process.platform || item.arch !== process.arch) {
        return false
      }

      // When building for the current platform, prefer a single native binary by default.
      // Baseline binaries require additional Bun artifacts and can be flaky to download.
      if (item.avx2 === false) {
        return baselineFlag
      }

      // also skip abi-specific builds for the same reason
      if (item.abi !== undefined) {
        return false
      }

      return true
    })
  : allTargets

await $`rm -rf dist`

const binaries: Record<string, string> = {}
if (!skipInstall) {
  await $`bun install --os="*" --cpu="*" @opentui/core@${pkg.dependencies["@opentui/core"]}`
  await $`bun install --os="*" --cpu="*" @parcel/watcher@${pkg.dependencies["@parcel/watcher"]}`
  await $`bun install --os="*" --cpu="*" @ff-labs/fff-bun@${pkg.dependencies["@ff-labs/fff-bun"]}`
}
const workerPath = "./src/cli/tui/worker.ts"
const treeSitterWorkerPath = "opentui-tree-sitter-worker.js"

const webUIModules = embeddedFileMap ? await Licenses.recordedModules(path.join(appDir, "dist")) : []
const notice = await Bun.file(Licenses.NOTICE_PATH).text()
const bun = await Licenses.bunRuntime()
// Keyed by os/arch/abi, the only target fields the bundle varies on: avx2 and baseline builds of one
// platform bundle the same modules, so they share one license pre-pass.
const manifests = new Map<string, { bundled: Set<string>; text: string }>()

for (const item of targets) {
  const name = [
    pkg.name,
    // changing to win32 flags npm for some reason
    item.os === "win32" ? "windows" : item.os,
    item.arch,
    item.avx2 === false ? "baseline" : undefined,
    item.abi === undefined ? undefined : item.abi,
  ]
    .filter(Boolean)
    .join("-")
  console.log(`building ${name}`)
  await $`mkdir -p dist/${name}/bin`

  const bunfsRoot = item.os === "win32" ? "B:/~BUN/root/" : "/$bunfs/root/"
  // Everything but `compile`, shared by the license pre-pass and the compile so both see one module graph.
  const options = {
    conditions: ["bun", "node"],
    tsconfig: "./tsconfig.json",
    plugins: [plugin],
    external: ["node-gyp"],
    format: "esm" as const,
    minify: true,
    sourcemap: sourcemapsFlag ? ("linked" as const) : ("none" as const),
    splitting: true,
    metafile: true,
    files: {
      [treeSitterWorkerPath]: treeSitterWorker,
      ...(embeddedFileMap ? { "opencode-web-ui.gen.ts": embeddedFileMap } : {}),
    },
    entrypoints: [
      "./src/index.ts",
      workerPath,
      treeSitterWorkerPath,
      ...(embeddedFileMap ? ["opencode-web-ui.gen.ts"] : []),
    ],
    define: {
      FFF_LIBC: JSON.stringify(item.abi === "musl" ? "musl" : "gnu"),
      OPENCODE_VERSION: `'${Script.version}'`,
      OPENCODE_MODELS_DEV: generated.modelsData,
      OTUI_TREE_SITTER_WORKER_PATH: bunfsRoot + treeSitterWorkerPath,
      OPENCODE_WORKER_PATH: workerPath,
      OPENCODE_CHANNEL: `'${Script.channel}'`,
      OPENCODE_LIBC: item.os === "linux" ? `'${item.abi ?? "glibc"}'` : "",
      ...(item.os === "linux" ? { "process.env.OPENTUI_LIBC": JSON.stringify(item.abi ?? "glibc") } : {}),
    } as Record<string, string>,
  }
  // The binary embeds its own license manifest, so it has to exist before the compile. Bun's compile
  // folds process.platform/arch for the target, which selects native packages (opentui, watcher,
  // fff); a plain bundle with the same folding sees the same modules, and the compile is checked below.
  const platform = `${item.os}-${item.arch}-${item.abi ?? ""}`
  if (!manifests.has(platform)) {
    const prepass = await Bun.build({
      ...options,
      target: "bun",
      // A source map doesn't change which modules are bundled. Minify and splitting do, so the pre-pass
      // keeps the compile's: minify's constant folding is what turns a require such as core's
      // `@parcel/watcher-${process.platform}-...` into one static package for the target, and
      // splitting shifts what tree-shaking drops.
      sourcemap: "none",
      define: {
        ...options.define,
        "process.platform": JSON.stringify(item.os),
        "process.arch": JSON.stringify(item.arch),
      },
    })
    const bundled = Licenses.packageRoots(Licenses.metafileModules(prepass.metafile))
    // The Bun runtime first: the compile embeds it in every binary.
    const packages = [bun, ...(await Licenses.manifest([...bundled, ...Licenses.packageRoots(webUIModules)]))]
    manifests.set(platform, { bundled, text: Licenses.render(packages, { product: `${Brand.name} CLI` }) })
  }
  const licenses = manifests.get(platform)!
  const result = await Bun.build({
    ...options,
    compile: {
      autoloadBunfig: false,
      autoloadDotenv: false,
      autoloadTsconfig: true,
      autoloadPackageJson: true,
      target: name.replace(pkg.name, "bun") as any,
      outfile: `dist/${name}/bin/jollicode`,
      execArgv: [`--user-agent=${Brand.userAgent(Script.version)}`, "--use-system-ca", "--"],
      windows: {},
    },
    define: { ...options.define, OPENCODE_LICENSES: JSON.stringify(`${notice}\n${licenses.text}`) },
  })
  // The pre-pass has to match the compile both ways: a missing package would ship unattributed, and an
  // extra one would make the manifest's package count wrong. The embedded Web UI reaches the compile
  // as files, not modules, so its packages stay out of the comparison.
  const compiled = Licenses.packageRoots(Licenses.metafileModules(result.metafile))
  const mismatched = [
    ...[...compiled].filter((root) => !licenses.bundled.has(root)).map((root) => `missing: ${root}`),
    ...[...licenses.bundled].filter((root) => !compiled.has(root)).map((root) => `extra: ${root}`),
  ]
  if (mismatched.length > 0)
    throw new Error(`${name}'s license manifest does not match what it bundles:\n${mismatched.join("\n")}`)
  // Next to the binary, so the release archives (which pack bin/*) and the npm platform package carry them.
  await Licenses.write(`dist/${name}/bin`, licenses.text)

  // Smoke test: only run if binary is for current platform
  if (item.os === process.platform && item.arch === process.arch && !item.abi) {
    const binaryPath = `dist/${name}/bin/jollicode`
    console.log(`Running smoke test: ${binaryPath} --version`)
    try {
      const versionOutput = await $`${binaryPath} --version`.text()
      console.log(`Smoke test passed: ${versionOutput.trim()}`)
    } catch (e) {
      console.error(`Smoke test failed for ${name}:`, e)
      process.exit(1)
    }
  }

  await $`rm -rf ./dist/${name}/bin/tui`
  await Bun.file(`dist/${name}/package.json`).write(
    JSON.stringify(
      {
        name,
        version: Script.version,
        preferUnplugged: true,
        os: [item.os],
        cpu: [item.arch],
        ...(item.abi ? { libc: [item.abi] } : {}),
      },
      null,
      2,
    ),
  )
  binaries[name] = Script.version
}

if (Script.release) {
  for (const key of Object.keys(binaries)) {
    if (key.includes("linux")) {
      await $`tar -czf ../../${key}.tar.gz *`.cwd(`dist/${key}/bin`)
    } else {
      await $`zip -r ../../${key}.zip *`.cwd(`dist/${key}/bin`)
    }
  }
  await $`gh release upload ${Script.tag} ./dist/*.zip ./dist/*.tar.gz --clobber --repo ${process.env.GH_REPO}`
}

export { binaries }
