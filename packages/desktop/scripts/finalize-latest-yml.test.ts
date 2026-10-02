import { expect, test } from "bun:test"
import { chmod, mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

// Every desktop build leg uploads one manifest; the finalizer expects all of them.
// The first releases ship macOS only, so the Windows and Linux legs are commented out here, in the
// finalizer, and in the publish-desktop workflow matrix. Restore all three together.
const MANIFESTS = [
  // ["latest-yml-x86_64-pc-windows-msvc", "latest.yml"],
  // ["latest-yml-aarch64-pc-windows-msvc", "latest.yml"],
  // ["latest-yml-x86_64-unknown-linux-gnu", "latest-linux.yml"],
  // ["latest-yml-aarch64-unknown-linux-gnu", "latest-linux-arm64.yml"],
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
  // The stand-in also prints each uploaded file, so the test can check what was merged into it.
  if (process.platform === "win32") {
    await Bun.write(
      path.join(dir, "bin", "gh.cmd"),
      '@echo off\r\necho gh %*\r\nif "%1 %2"=="release upload" type "%4"\r\n',
    )
  } else {
    await Bun.write(
      path.join(dir, "bin", "gh"),
      '#!/bin/sh\necho "gh $*"\nif [ "$1 $2" = "release upload" ]; then cat "$4"; fi\n',
    )
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
  const result = await finalize({ macArm64Version: "0.0.0" })
  expect(result.exitCode).not.toBe(0)
  expect(result.stderr).toContain("latest-mac.yml has version 0.0.0, expected 0.0.2")
  expect(result.stdout).not.toContain("gh release upload")
})

test("refuses to finalize when a build leg's manifest is missing", async () => {
  const result = await finalize({ skip: "latest-yml-x86_64-apple-darwin" })
  expect(result.exitCode).not.toBe(0)
  expect(result.stderr).toContain("latest-yml-x86_64-apple-darwin")
  expect(result.stdout).not.toContain("gh release upload")
})

test("uploads merged manifests with the release version", async () => {
  const result = await finalize()
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain("gh release upload desktop-v0.0.2")
  // for (const filename of ["latest.yml", "latest-linux.yml", "latest-linux-arm64.yml", "latest-mac.yml"])
  for (const filename of ["latest-mac.yml"]) expect(result.stdout).toContain(`uploaded ${filename}`)
})

test("merges both architectures into the macOS manifest", async () => {
  const result = await finalize()
  const uploaded = (filename: string) =>
    result.stdout.split("gh release upload").find((chunk) => chunk.includes(`uploaded ${filename}`)) ?? ""
  // expect(uploaded("latest.yml")).toContain("url: latest-yml-aarch64-pc-windows-msvc.bin")
  // expect(uploaded("latest.yml")).toContain("url: latest-yml-x86_64-pc-windows-msvc.bin")
  expect(uploaded("latest-mac.yml")).toContain("url: latest-yml-aarch64-apple-darwin.bin")
  expect(uploaded("latest-mac.yml")).toContain("url: latest-yml-x86_64-apple-darwin.bin")
  expect(uploaded("latest-mac.yml")).toContain("version: 0.0.2")
})
