import { afterEach, describe, expect, mock, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const userData = mkdtempSync(join(tmpdir(), "jolli-sidecar-env-"))
/**
 * ⚠ THE ELECTRON MOCK IS A SUPERSET OF WHAT THIS FILE NEEDS, AND DELIBERATELY IDENTICAL TO THE ONE
 * IN THE OTHER MAIN-PROCESS TEST. `mock.module` is process-wide in bun and last-writer-wins, so two
 * partial mocks of the same module break whichever file loads second.
 */
const app = { getPath: () => userData, setPath: () => {}, getVersion: () => "9.9.9", focus: () => {} }

mock.module("electron", () => ({ default: { app }, app, utilityProcess: {}, crashReporter: {}, netLog: {}, shell: {} }))

const { createSidecarEnv } = await import("./server")

const touched = new Set<string>()
const set = (key: string, value: string) => {
  touched.add(key)
  process.env[key] = value
}

afterEach(() => {
  for (const key of touched) delete process.env[key]
  touched.clear()
})

describe("createSidecarEnv", () => {
  test("turns on the server's own Jolli floor and its ceiling", async () => {
    const env = await createSidecarEnv()
    /**
     * ⚠ WITHOUT THESE THE REST OF THE DESIGN IS A NO-OP. `packages/opencode/src/config/config.ts`
     * gates the Jolli floor on `JOLLICODE_LOCKDOWN`, and the flag is set by the CLI entry point —
     * which the sidecar does not go through. The strict flag is what runs the post-merge pass that
     * layering cannot express: no config-supplied credential, the tenant's own endpoint, and no
     * provider block at all while signed out.
     */
    expect(env["JOLLICODE_LOCKDOWN"]).toBe("1")
    expect(env["JOLLICODE_LOCKDOWN_STRICT"]).toBe("1")
  })

  test("carries the ceiling but never a credential", async () => {
    const config = JSON.parse((await createSidecarEnv())["JOLLICODE_CONFIG_CONTENT"] ?? "{}")
    expect(config.enabled_providers).toEqual(["jolli-anthropic", "jolli-openai", "jolli-google"])
    // The credential comes from the shared database, resolved per request by the provider's fetch —
    // for every protocol block, since `plugin/jolli.ts` claims all three provider ids.
    for (const id of config.enabled_providers) expect(config.provider?.[id]?.options).not.toHaveProperty("apiKey")
    expect((await createSidecarEnv())["JOLLICODE_JOLLI_TOKEN"]).toBeUndefined()
  })

  test("scrubs every config surface a login shell could have exported", async () => {
    /**
     * ⚠ THIS SCRUB IS PERMANENT, NOT TRANSITIONAL. `preferAppEnv` sources the student's login shell
     * into `process.env`, and `jolli/session.ts` still honours `JOLLICODE_JOLLI_TOKEN` as the
     * development override for a hand-started server — so without this, a line in `~/.zshrc` would
     * decide which account this app acts as. `DB` is the same hole one layer down: the database is
     * the credential store and the lockdown's source of truth now.
     */
    for (const key of [
      "JOLLICODE_CONFIG_CONTENT",
      "OPENCODE_CONFIG_CONTENT",
      "JOLLICODE_JOLLI_TOKEN",
      "OPENCODE_JOLLI_TOKEN",
      "JOLLICODE_JOLLI_BASE_URL",
      "JOLLICODE_DB",
      "OPENCODE_DB",
      "JOLLICODE_AUTH_CONTENT",
      "OPENCODE_AUTH_CONTENT",
      "JOLLICODE_PERMISSION",
      "JOLLICODE_MODELS_URL",
      /**
       * ⚠ THE SHARPEST ONE ON THIS LIST. A pinned gateway is exempt from the origin allowlist and
       * the provider's own `fetch` attaches the student's credential to it (`plugin/jolli.ts`), so
       * an inherited `JOLLICODE_GATEWAY_URL` would be a line in `~/.zshrc` naming where that
       * credential gets sent. Only a value baked into this build may occupy this key.
       */
      "JOLLICODE_GATEWAY_URL",
      "OPENCODE_GATEWAY_URL",
    ]) {
      set(key, "student-supplied")
    }

    const result = await createSidecarEnv()

    for (const key of [
      "OPENCODE_CONFIG_CONTENT",
      "JOLLICODE_JOLLI_TOKEN",
      "OPENCODE_JOLLI_TOKEN",
      "JOLLICODE_JOLLI_BASE_URL",
      "JOLLICODE_DB",
      "OPENCODE_DB",
      "JOLLICODE_AUTH_CONTENT",
      "OPENCODE_AUTH_CONTENT",
      "JOLLICODE_PERMISSION",
      "JOLLICODE_MODELS_URL",
      "JOLLICODE_GATEWAY_URL",
      "OPENCODE_GATEWAY_URL",
    ]) {
      expect(result[key]).toBeUndefined()
    }
    // The one it rewrites rather than removes.
    expect(result["JOLLICODE_CONFIG_CONTENT"]).not.toBe("student-supplied")
  })
})
