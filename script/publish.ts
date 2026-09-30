#!/usr/bin/env bun

import { Script } from "@opencode-ai/script"
import { $ } from "bun"
import { fileURLToPath } from "url"

console.log("=== publishing ===\n")

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)
const tag = Script.tag

// The desktop app and the VS Code extension take their versions from their own CHANGELOG.md, so CLI
// releases must not stamp their package.json files.
const pkgjsons = await Array.fromAsync(
  new Bun.Glob("**/package.json").scan({
    absolute: true,
  }),
).then((arr) =>
  arr
    .map((x) => x.replaceAll("\\", "/"))
    .filter(
      (x) =>
        !x.includes("node_modules") &&
        !x.includes("dist") &&
        !x.includes("/packages/desktop/") &&
        !x.includes("/sdks/vscode/"),
    ),
)

async function prepareReleaseFiles() {
  for (const file of pkgjsons) {
    let pkg = await Bun.file(file).text()
    pkg = pkg.replaceAll(/"version": "[^"]+"/g, `"version": "${Script.version}"`)
    console.log("updated:", file)
    await Bun.file(file).write(pkg)
  }

  await $`bun install`
  await $`./packages/sdk/js/script/build.ts`
}

// Stamps the released versions onto the tip of dev and pushes that commit. A PR merged into dev after
// the fetch rejects the push as non-fast-forward. Stamping is deterministic, so each attempt restamps
// the new tip instead of rebasing the old commit onto it, which could conflict on a version line.
// Other rejections, such as a ruleset, fail at once.
async function syncVersionsToDev() {
  for (let attempt = 1; ; attempt++) {
    await $`git fetch origin dev`
    await $`git checkout -f -B dev origin/dev`
    await prepareReleaseFiles()
    await $`git commit -am "sync release versions for ${tag}"`
    const push = await $`git push origin HEAD:dev --no-verify`.nothrow()
    if (push.exitCode === 0) return
    const stderr = push.stderr.toString()
    if (attempt === 5 || !/non-fast-forward|fetch first/.test(stderr))
      throw new Error(`failed to push the version sync to dev:\n${stderr}`)
  }
}

if (Script.release && !Script.preview) {
  await $`git fetch origin --tags`
  await $`git switch --detach`
}

await prepareReleaseFiles()

console.log("\n=== cli ===\n")
await $`bun ./packages/opencode/script/publish.ts`

// sdk, plugin, and ui are internal-only packages and are intentionally not
// published to the public npm registry. They keep their @opencode-ai/*
// workspace names as an internal contract; only the CLI is distributed.

if (Script.release && !Script.preview) {
  await $`git commit -am "release: ${tag}"`
  await $`git tag -d ${tag}`.nothrow()
  await $`git tag ${tag}`
  await $`git push origin refs/tags/${tag} --force-with-lease --no-verify`
  await new Promise((resolve) => setTimeout(resolve, 5_000))
  await syncVersionsToDev()
}

if (Script.release) {
  await $`gh release edit ${tag} --draft=false --repo ${process.env.GH_REPO}`
}
