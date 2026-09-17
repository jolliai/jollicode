import { afterEach, describe, expect, test } from "bun:test"
import { ModelGrant, isModelAllowed } from "./model-grant"

// The grant is a module signal, so reset it after each test to keep them independent.
afterEach(() => {
  ModelGrant.set({ allowed: [], preferred: undefined, bound: false })
})

describe("isModelAllowed", () => {
  /**
   * ⚠ THE REVERSE-INTUITIVE RULE THIS FILE EXISTS FOR: an empty grant is unrestricted, not "deny
   * all". A course that never configured model access must behave like the product did before grants
   * existed, so an empty picker would read as a broken app rather than an unconfigured course.
   */
  test("an empty grant allows every model", () => {
    ModelGrant.set({ allowed: [], preferred: undefined, bound: true })
    expect(isModelAllowed("jolli", "claude-opus-5")).toBe(true)
    expect(isModelAllowed("anything", "at-all")).toBe(true)
  })

  test("a non-empty grant allows only the listed models", () => {
    ModelGrant.set({ allowed: ["jolli/claude-opus-5", "jolli/claude-sonnet-5"], preferred: undefined, bound: true })
    expect(isModelAllowed("jolli", "claude-opus-5")).toBe(true)
    expect(isModelAllowed("jolli", "claude-sonnet-5")).toBe(true)
    expect(isModelAllowed("jolli", "claude-haiku-4-5")).toBe(false)
    expect(isModelAllowed("other", "claude-opus-5")).toBe(false)
  })
})

describe("ModelGrant.set", () => {
  test("updates allowed, preferred, and bound together", () => {
    ModelGrant.set({ allowed: ["jolli/claude-opus-5"], preferred: "jolli/claude-opus-5", bound: true })
    expect(ModelGrant.allowed()).toEqual(["jolli/claude-opus-5"])
    expect(ModelGrant.preferred()).toBe("jolli/claude-opus-5")
    expect(ModelGrant.bound()).toBe(true)
  })

  /**
   * ⚠ `bound` IS NOT THE SAME AS AN EMPTY GRANT. No assistant bound means no course chosen (the
   * composer greys its model control); an empty grant on a bound assistant means "everything, on
   * purpose". The two must stay independently observable.
   */
  test("an unbound state with an empty grant is distinct from a bound empty grant", () => {
    ModelGrant.set({ allowed: [], preferred: undefined, bound: false })
    expect(ModelGrant.bound()).toBe(false)
    expect(isModelAllowed("jolli", "claude-opus-5")).toBe(true)
  })
})
