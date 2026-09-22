import { describe, expect, test } from "bun:test"
import { viewerFromToken } from "../src/jolli/identity"
import { base64Encode } from "../src/util/encode"

/** A JWT's shape is all this reads: header, payload, signature — none of it verified. */
function token(payload: Record<string, unknown>) {
  return `${base64Encode(JSON.stringify({ alg: "RS256" }))}.${base64Encode(JSON.stringify(payload))}.signature`
}

describe("viewerFromToken", () => {
  test("reads a name and an email", () => {
    expect(viewerFromToken(token({ name: "Ada Lovelace", email: "ada@jolli.ai" }))).toEqual({
      name: "Ada Lovelace",
      email: "ada@jolli.ai",
    })
  })

  test("falls back to the given and family names", () => {
    expect(viewerFromToken(token({ given_name: "Ada", family_name: "Lovelace" }))?.name).toBe("Ada Lovelace")
    expect(viewerFromToken(token({ given_name: "Ada" }))?.name).toBe("Ada")
    expect(viewerFromToken(token({ family_name: "Lovelace" }))?.name).toBe("Lovelace")
  })

  test("names somebody from their address when nothing else will", () => {
    expect(viewerFromToken(token({ email: "ada@jolli.ai" }))).toEqual({ name: "ada", email: "ada@jolli.ai" })
  })

  /**
   * ⚠ THE REGRESSION. `indexOf` answers `-1` on a claim with no `@`, and `slice(0, -1)` drops the
   * last character rather than returning nothing — so `alice.smith` was rendered as `alice.smit`.
   */
  test("does not invent a name from an address-shaped claim that is not an address", () => {
    expect(viewerFromToken(token({ email: "alice.smith" }))).toEqual({ email: "alice.smith" })
    expect(viewerFromToken(token({ email: "ada" }))).toEqual({ email: "ada" })
    expect(viewerFromToken(token({ email: "@jolli.ai" }))).toEqual({ email: "@jolli.ai" })
  })

  test("treats preferred_username as an address only when it looks like one", () => {
    expect(viewerFromToken(token({ preferred_username: "ada@jolli.ai" }))?.email).toBe("ada@jolli.ai")
    expect(viewerFromToken(token({ preferred_username: "ada" }))).toEqual({ name: "ada" })
  })

  /**
   * ⚠ NON-ASCII IS THE REASON THIS REUSES `base64Decode` RATHER THAN HAND-ROLLING `atob`. A name
   * mangled into mojibake is worse than no name.
   */
  test("survives non-ASCII names", () => {
    expect(viewerFromToken(token({ name: "李雷" }))?.name).toBe("李雷")
    expect(viewerFromToken(token({ name: "José Ramírez" }))?.name).toBe("José Ramírez")
  })

  /**
   * ⚠ JWT SEGMENTS ARE UNPADDED BY SPEC AND `atob` REJECTS THAT. Every payload length mod 4 has to
   * decode, so this walks all four residues.
   */
  test("decodes payloads of every unpadded length", () => {
    for (const name of ["a", "ab", "abc", "abcd"]) {
      expect(viewerFromToken(token({ name }))?.name).toBe(name)
    }
  })

  /** ⚠ A CLAIM OF THE WRONG TYPE IS IGNORED, NOT COERCED — or the row renders `[object Object]`. */
  test("ignores claims that are not strings", () => {
    expect(viewerFromToken(token({ name: 42, email: { address: "ada@jolli.ai" } }))).toBeUndefined()
    expect(viewerFromToken(token({ name: ["Ada"] }))).toBeUndefined()
    expect(viewerFromToken(token({ name: "   " }))).toBeUndefined()
  })

  test("caps a pathological claim", () => {
    const name = viewerFromToken(token({ name: "x".repeat(500) }))?.name
    expect(name?.length).toBe(120)
  })

  test("says nothing rather than guessing", () => {
    // The shape this repo's own route tests use for a fake credential: not a JWT at all.
    expect(viewerFromToken("jwt")).toBeUndefined()
    expect(viewerFromToken("")).toBeUndefined()
    expect(viewerFromToken("a.b")).toBeUndefined()
    expect(viewerFromToken(`${base64Encode("{}")}.not-base64-$$$.sig`)).toBeUndefined()
    expect(viewerFromToken(token({ sub: "user_123", exp: 1 }))).toBeUndefined()
  })

  /** A payload that decodes to something other than an object must not be treated as claims. */
  test("refuses a non-object payload", () => {
    expect(viewerFromToken(`h.${base64Encode('"a string"')}.s`)).toBeUndefined()
    expect(viewerFromToken(`h.${base64Encode("[1,2]")}.s`)).toBeUndefined()
    expect(viewerFromToken(`h.${base64Encode("null")}.s`)).toBeUndefined()
  })
})
