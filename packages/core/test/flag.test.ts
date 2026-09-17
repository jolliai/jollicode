import { afterEach, describe, expect, test } from "bun:test"
import { env, envKey, Flag, truthyEnv } from "@opencode-ai/core/flag/flag"

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
