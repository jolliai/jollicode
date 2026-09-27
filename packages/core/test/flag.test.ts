import { afterEach, describe, expect, test } from "bun:test"
import { Config, ConfigProvider, Effect, Exit } from "effect"
import { env, envConfig, envKey, Flag, truthyEnv } from "@opencode-ai/core/flag/flag"

const KEYS = ["JOLLICODE_UNIT_TEST_KEY", "OPENCODE_UNIT_TEST_KEY"]
afterEach(() => {
  for (const k of KEYS) delete process.env[k]
})

describe("env fallback", () => {
  test("prefers JOLLICODE_ over OPENCODE_", () => {
    process.env.JOLLICODE_UNIT_TEST_KEY = "new"
    process.env.OPENCODE_UNIT_TEST_KEY = "old"
    expect(env("UNIT_TEST_KEY")).toBe("new")
  })

  test("falls back to OPENCODE_ when JOLLICODE_ unset", () => {
    process.env.OPENCODE_UNIT_TEST_KEY = "old"
    expect(env("UNIT_TEST_KEY")).toBe("old")
  })

  test("returns undefined when neither is set", () => {
    expect(env("UNIT_TEST_KEY")).toBeUndefined()
  })

  test("truthyEnv reads through the fallback", () => {
    process.env.OPENCODE_UNIT_TEST_KEY = "1"
    expect(truthyEnv("UNIT_TEST_KEY")).toBe(true)
    process.env.JOLLICODE_UNIT_TEST_KEY = "false"
    expect(truthyEnv("UNIT_TEST_KEY")).toBe(false)
  })
})

describe("envConfig falls back only on a missing canonical key", () => {
  const read = (vars: Record<string, string>) =>
    Effect.runSyncExit(envConfig(Config.boolean, "UNIT_TEST_KEY").parse(ConfigProvider.fromUnknown(vars)))

  test("prefers JOLLICODE_ over OPENCODE_", () => {
    expect(read({ JOLLICODE_UNIT_TEST_KEY: "true", OPENCODE_UNIT_TEST_KEY: "false" })).toEqual(Exit.succeed(true))
  })

  test("falls back to OPENCODE_ when JOLLICODE_ is unset", () => {
    expect(read({ OPENCODE_UNIT_TEST_KEY: "true" })).toEqual(Exit.succeed(true))
  })

  test("fails on an invalid JOLLICODE_ value instead of using the alias", () => {
    expect(Exit.isFailure(read({ JOLLICODE_UNIT_TEST_KEY: "maybe", OPENCODE_UNIT_TEST_KEY: "true" }))).toBe(true)
  })
})

describe("Flag registry honors JOLLICODE_ alias", () => {
  afterEach(() => {
    delete process.env.JOLLICODE_DISABLE_AUTOUPDATE
    delete process.env.OPENCODE_DISABLE_AUTOUPDATE
  })

  test("JOLLICODE_DISABLE_AUTOUPDATE is read (getter re-evaluates)", () => {
    // Flag.OPENCODE_DISABLE_AUTOUPDATE is a getter, so it re-reads the env at access time and picks up
    // the canonical JOLLICODE_ prefix set here rather than a value frozen at module load.
    process.env.JOLLICODE_DISABLE_AUTOUPDATE = "1"
    expect(Flag.OPENCODE_DISABLE_AUTOUPDATE).toBe(true)
  })
})

describe("envKey reports the actual source prefix", () => {
  afterEach(() => {
    delete process.env.JOLLICODE_CONFIG_CONTENT
    delete process.env.OPENCODE_CONFIG_CONTENT
  })

  test("returns the canonical key when it is set", () => {
    process.env.JOLLICODE_CONFIG_CONTENT = "{}"
    expect(envKey("CONFIG_CONTENT")).toBe("JOLLICODE_CONFIG_CONTENT")
  })

  test("returns the legacy key when only the alias is set", () => {
    process.env.OPENCODE_CONFIG_CONTENT = "{}"
    expect(envKey("CONFIG_CONTENT")).toBe("OPENCODE_CONFIG_CONTENT")
  })

  test("prefers the canonical key when both are set", () => {
    process.env.JOLLICODE_CONFIG_CONTENT = "{}"
    process.env.OPENCODE_CONFIG_CONTENT = "{}"
    expect(envKey("CONFIG_CONTENT")).toBe("JOLLICODE_CONFIG_CONTENT")
  })

  test("returns undefined when neither is set", () => {
    expect(envKey("CONFIG_CONTENT")).toBeUndefined()
  })
})

/**
 * ⚠ THIS IS A SECURITY GATE, NOT A PREFERENCE. A pinned gateway is exempt from the Jolli origin
 * allowlist (`jolli/gateway-config.ts`) and the provider's own `fetch` attaches the student's
 * credential to it (`plugin/jolli.ts`) — which is what a build aimed at a fixture needs, and what
 * an exported shell variable must never be able to claim. The value only means anything when
 * `createSidecarEnv()` put it there, and that is the only thing that sets the strict flag.
 */
describe("Flag.JOLLICODE_GATEWAY_URL is only honoured on the locked surface", () => {
  afterEach(() => {
    delete process.env.JOLLICODE_GATEWAY_URL
    delete process.env.OPENCODE_GATEWAY_URL
    delete process.env.JOLLICODE_LOCKDOWN_STRICT
  })

  test("answers nothing without strict lockdown, whichever prefix carries it", () => {
    process.env.JOLLICODE_GATEWAY_URL = "https://evil.example"
    expect(Flag.JOLLICODE_GATEWAY_URL).toBeUndefined()

    delete process.env.JOLLICODE_GATEWAY_URL
    process.env.OPENCODE_GATEWAY_URL = "https://evil.example"
    expect(Flag.JOLLICODE_GATEWAY_URL).toBeUndefined()
  })

  test("answers the pin the sidecar env carries", () => {
    process.env.JOLLICODE_LOCKDOWN_STRICT = "1"
    process.env.JOLLICODE_GATEWAY_URL = "https://fixture.internal/gw"
    expect(Flag.JOLLICODE_GATEWAY_URL).toBe("https://fixture.internal/gw")
  })

  // An unpinned build exports the key as an empty string rather than not at all; that is not a pin.
  test("treats an empty pin as no pin", () => {
    process.env.JOLLICODE_LOCKDOWN_STRICT = "1"
    process.env.JOLLICODE_GATEWAY_URL = "  "
    expect(Flag.JOLLICODE_GATEWAY_URL).toBeUndefined()
  })
})
