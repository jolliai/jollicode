import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

// Runs the finalizer against one macOS manifest. The repo does not exist, so a run that gets past the
// version check fails at the upload instead.
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
  const result = Bun.spawnSync([process.execPath, path.join(import.meta.dir, "finalize-latest-yml.ts")], {
    env: { ...process.env, LATEST_YML_DIR: dir, GH_REPO: "jolliai/does-not-exist-xyz", RELEASE_TAG: "desktop-v0.0.2" },
  })
  await rm(dir, { recursive: true })
  return { exitCode: result.exitCode, stderr: result.stderr.toString() }
}

test("refuses to upload a manifest whose version does not match the release tag", async () => {
  const result = await finalize("1.18.31")
  expect(result.exitCode).not.toBe(0)
  expect(result.stderr).toContain("latest-mac.yml has version 1.18.31, expected 0.0.2")
})

test("lets a manifest with the release version through to the upload", async () => {
  const result = await finalize("0.0.2")
  expect(result.stderr).not.toContain("has version")
  expect(result.stderr).toContain("Could not resolve to a Repository")
})
