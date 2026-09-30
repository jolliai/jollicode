import { expect, test } from "bun:test"
import { chmod, mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

// Runs the finalizer against one macOS manifest. A stand-in `gh` on PATH records the upload instead of
// calling GitHub, so the result does not depend on the machine's gh login.
async function finalize(manifestVersion: string) {
  const dir = await mkdtemp(path.join(tmpdir(), "latest-yml-"))
  await mkdir(path.join(dir, "latest-yml-aarch64-apple-darwin"))
  await Bun.write(
    path.join(dir, "latest-yml-aarch64-apple-darwin", "latest-mac.yml"),
    [
      `version: ${manifestVersion}`,
      "files:",
      "  - url: jollicode-desktop-mac-arm64.zip",
      "    sha512: abc",
      "    size: 1",
      "releaseDate: '2026-09-30T00:00:00.000Z'",
      "",
    ].join("\n"),
  )
  await mkdir(path.join(dir, "bin"))
  await Bun.write(path.join(dir, "bin", "gh"), '#!/bin/sh\necho "gh $*"\n')
  await chmod(path.join(dir, "bin", "gh"), 0o755)
  const result = Bun.spawnSync([process.execPath, path.join(import.meta.dir, "finalize-latest-yml.ts")], {
    env: {
      ...process.env,
      PATH: `${path.join(dir, "bin")}${path.delimiter}${process.env.PATH}`,
      LATEST_YML_DIR: dir,
      GH_REPO: "jolliai/jollicode-releases",
      RELEASE_TAG: "desktop-v0.0.2",
      RUNNER_TEMP: dir,
    },
  })
  await rm(dir, { recursive: true })
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
}

test("refuses to upload a manifest whose version does not match the release tag", async () => {
  const result = await finalize("1.18.31")
  expect(result.exitCode).not.toBe(0)
  expect(result.stderr).toContain("latest-mac.yml has version 1.18.31, expected 0.0.2")
  expect(result.stdout).not.toContain("gh release upload")
})

test("uploads a manifest with the release version", async () => {
  const result = await finalize("0.0.2")
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain("gh release upload desktop-v0.0.2")
  expect(result.stdout).toContain("uploaded latest-mac.yml")
})
