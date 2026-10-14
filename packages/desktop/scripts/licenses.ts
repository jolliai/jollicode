#!/usr/bin/env bun
import { rm } from "node:fs/promises"
import path from "node:path"
import { Brand } from "@opencode-ai/core/brand"
import { Licenses } from "@opencode-ai/script/licenses"
import { CLI_LICENSES, resolveChannel } from "./utils"

// Runs after `electron-vite build`; electron-builder ships out/licenses as extraResources. The app
// carries third-party code three ways: modules Vite inlined into out/, the server bundle inlined
// into main (recorded by packages/opencode/script/build-node.ts), and the production dependencies
// electron-builder copies into the asar verbatim.
const OUT = "out/licenses"
await rm(OUT, { recursive: true, force: true })

// Dev builds also ship the compiled CLI (scripts/prebuild.ts), a Bun binary whose bundle differs from
// the app's; its manifest ships beside it rather than merged in here.
const cli = resolveChannel() === "dev"
if (cli && !(await Bun.file(CLI_LICENSES).exists()))
  throw new Error(`${CLI_LICENSES} is missing; scripts/prebuild.ts writes it with the dev-channel CLI`)

const modules = await Promise.all(
  ["out/main", "out/preload", "out/renderer", "../opencode/dist/node"].map(Licenses.recordedModules),
)
const packages = await Licenses.manifest([
  ...Licenses.packageRoots(modules.flat()),
  ...(await Licenses.dependencyRoots(".")),
])

// One file, NOTICE first, so Help > Third-Party Licenses (src/main/desktop-menu-actions.ts) opens
// everything the CLI's `licenses` command prints. `.txt` so the OS has an app to open it with.
await Bun.write(
  path.join(OUT, "THIRD-PARTY-LICENSES.txt"),
  [
    await Bun.file(Licenses.NOTICE_PATH).text(),
    Licenses.render(packages, {
      product: `${Brand.name} Desktop`,
      preamble: [
        "The app is built on Electron. Electron's license and the notices for Chromium and its",
        "third-party components are in LICENSE.electron.txt and LICENSES.chromium.html next to this file.",
        ...(cli
          ? [
              "",
              "The bundled jollicode-cli binary runs on Bun; its notices, Bun's included, are in",
              `${path.basename(CLI_LICENSES)} next to this file.`,
            ]
          : []),
      ],
    }),
  ].join("\n"),
)

// electron-builder drops these from macOS builds and leaves them outside resources/ elsewhere, so
// copy them in for every platform.
const electron = path.join(path.dirname(Bun.resolveSync("electron/package.json", import.meta.dir)), "dist")
await Bun.write(path.join(OUT, "LICENSE.electron.txt"), Bun.file(path.join(electron, "LICENSE")))
await Bun.write(path.join(OUT, "LICENSES.chromium.html"), Bun.file(path.join(electron, "LICENSES.chromium.html")))

console.log(`Wrote ${OUT} (${packages.length} packages)`)
