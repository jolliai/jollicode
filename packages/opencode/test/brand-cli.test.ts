import { describe, expect, test } from "bun:test"
import { Brand } from "@opencode-ai/core/brand"

describe("CLI branding", () => {
  test("--help output uses jollicode as the program name, not the legacy opencode banner", async () => {
    const proc = Bun.spawn(["bun", "run", "./src/index.ts", "--help"], {
      cwd: import.meta.dir + "/..",
      stdout: "pipe",
      stderr: "pipe",
    })
    await proc.exited
    const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text())
    // The program name in yargs usage output must be the new brand: every command-listing line is
    // prefixed with the scriptName, e.g. "  jollicode run ...". Anchor to that position rather than a
    // bare substring, so a stray "jollicode" anywhere in a description could not satisfy this.
    expect(out).toMatch(new RegExp(`^\\s*${Brand.bin}[ \\t]`, "m"))
    // No stray legacy program-name token: yargs prints the scriptName as the
    // first token on each command line ("  opencode <cmd>  description...") and
    // in any "Usage: opencode ..." line. Free-text mentions of "opencode" inside
    // command descriptions (e.g. "run opencode with a message") are out of scope
    // for this task (CLI entry rebrand only) and are not asserted against here.
    expect(out).not.toMatch(/^\s*opencode[ \t]/m)
    expect(out).not.toMatch(/Usage:\s*opencode\b/)
    expect(Brand.bin).toBe("jollicode")
  })
})
