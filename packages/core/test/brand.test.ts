import { describe, expect, test } from "bun:test"
import { Brand } from "@opencode-ai/core/brand"

describe("Brand", () => {
  test("carries the Jolli Code identity", () => {
    expect(Brand.name).toBe("Jolli Code")
    expect(Brand.bin).toBe("jollicode")
    expect(Brand.npm).toBe("@jolli.ai/jollicode")
    expect(Brand.short).toBe("jolli")
    expect(Brand.org).toBe("jolliai")
    expect(Brand.protocol).toBe("jollicode")
    expect(Brand.gatewayUrl).toBe("https://api.jolli.ai")
    expect(Brand.appUrl).toBe("https://app.jolli.ai")
    expect(Brand.docsUrl).toBe("https://docs.jolli.ai")
    expect(Brand.envPrefix).toBe("JOLLICODE_")
  })

  test("contains no legacy opencode branding in user-facing fields", () => {
    for (const field of [Brand.name, Brand.bin, Brand.npm, Brand.short]) {
      expect(field.toLowerCase()).not.toContain("opencode")
    }
  })
})
