import { describe, expect, test } from "bun:test"
import path from "path"

// Script resolves its version once at import time from the environment, so each case imports it
// in a fresh process.
function resolve(version: string, extra: Record<string, string> = {}) {
  const entry = JSON.stringify(path.join(import.meta.dir, "../src/index.ts"))
  const result = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `const { Script } = await import(${entry}); console.log("RESULT " + JSON.stringify({ version: Script.version, tag: Script.tag }))`,
    ],
    { env: { ...process.env, OPENCODE_VERSION: version, ...extra } },
  )
  const line = result.stdout
    .toString()
    .split("\n")
    .find((item) => item.startsWith("RESULT "))
  return { exitCode: result.exitCode, stderr: result.stderr.toString(), value: line && JSON.parse(line.slice(7)) }
}

describe("Script version override", () => {
  test("uses a bare version as-is", () => {
    expect(resolve("1.2.3").value).toEqual({ version: "1.2.3", tag: "cli-v1.2.3" })
  })

  test("accepts a version copied from a release tag", () => {
    expect(resolve("cli-v1.2.3").value).toEqual({ version: "1.2.3", tag: "cli-v1.2.3" })
    expect(resolve("v1.2.3").value).toEqual({ version: "1.2.3", tag: "cli-v1.2.3" })
  })

  test("keeps preview versions working", () => {
    expect(resolve("0.0.0-dev-202609300301").value?.version).toBe("0.0.0-dev-202609300301")
  })

  test("rejects a version that is not semver", () => {
    const result = resolve("1.2")
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('OPENCODE_VERSION "1.2" is not a valid semver version')
  })

  test("refuses a release channel without a version from the changelog", () => {
    const result = resolve("", { OPENCODE_CHANNEL: "latest" })
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("the latest channel needs OPENCODE_VERSION")
  })
})
