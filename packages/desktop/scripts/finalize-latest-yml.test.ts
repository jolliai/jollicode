import { expect, test } from "bun:test"
import { chmod, mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

// Every desktop build leg uploads one manifest; the finalizer expects all of them.
const MANIFESTS = [
  ["latest-yml-x86_64-pc-windows-msvc", "latest.yml"],
  ["latest-yml-aarch64-pc-windows-msvc", "latest.yml"],
  ["latest-yml-x86_64-unknown-linux-gnu", "latest-linux.yml"],
  ["latest-yml-aarch64-unknown-linux-gnu", "latest-linux-arm64.yml"],
  ["latest-yml-x86_64-apple-darwin", "latest-mac.yml"],
  ["latest-yml-aarch64-apple-darwin", "latest-mac.yml"],
] as const

// Runs the finalizer against a set of manifests. A stand-in `gh` on PATH records the upload instead of
// calling GitHub, so the result does not depend on the machine's gh login.
async function finalize(input: { macArm64Version?: string; skip?: string } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "latest-yml-"))
  for (const [subdir, filename] of MANIFESTS) {
    if (subdir === input.skip) continue
    const version = subdir === "latest-yml-aarch64-apple-darwin" ? (input.macArm64Version ?? "0.0.2") : "0.0.2"
    await mkdir(path.join(dir, subdir))
    await Bun.write(
      path.join(dir, subdir, filename),
      [
        `version: ${version}`,
        "files:",
        `  - url: ${subdir}.bin`,
        "    sha512: abc",
        "    size: 1",
        "releaseDate: '2026-09-30T00:00:00.000Z'",
        "",
      ].join("\n"),
    )
  }
  await mkdir(path.join(dir, "bin"))
  if (process.platform === "win32") {
    await Bun.write(path.join(dir, "bin", "gh.cmd"), "@echo off\r\necho gh %*\r\n")
  } else {
    await Bun.write(path.join(dir, "bin", "gh"), '#!/bin/sh\necho "gh $*"\n')
    await chmod(path.join(dir, "bin", "gh"), 0o755)
  }
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
  const result = await finalize({ macArm64Version: "1.18.31" })
  expect(result.exitCode).not.toBe(0)
  expect(result.stderr).toContain("latest-mac.yml has version 1.18.31, expected 0.0.2")
  expect(result.stdout).not.toContain("gh release upload")
})

test("refuses to finalize when a build leg's manifest is missing", async () => {
  const result = await finalize({ skip: "latest-yml-aarch64-unknown-linux-gnu" })
  expect(result.exitCode).not.toBe(0)
  expect(result.stderr).toContain("latest-yml-aarch64-unknown-linux-gnu")
  expect(result.stdout).not.toContain("gh release upload")
})

test("uploads merged manifests with the release version", async () => {
  const result = await finalize()
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain("gh release upload desktop-v0.0.2")
  for (const filename of ["latest.yml", "latest-linux.yml", "latest-linux-arm64.yml", "latest-mac.yml"])
    expect(result.stdout).toContain(`uploaded ${filename}`)
})
