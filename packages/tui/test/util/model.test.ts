import { describe, expect, test } from "bun:test"
import { parse, syncAcceptedModel } from "../../src/util/model"

describe("util.model", () => {
  test("splits provider from a nested model identifier", () => {
    expect(parse("provider/org/model")).toEqual({ providerID: "provider", modelID: "org/model" })
    expect(parse("invalid")).toEqual({ providerID: "invalid", modelID: "" })
  })
})

describe("syncAcceptedModel", () => {
  test("updates the selection and variant when the server switches models", () => {
    let current = { providerID: "jolli-anthropic", modelID: "claude-opus-5" }
    let variant: string | undefined = "high"
    syncAcceptedModel(
      {
        model: {
          current: () => current,
          set: (model) => {
            current = model
          },
          variant: { set: (value) => (variant = value) },
        },
      },
      current,
      { providerID: "jolli-google", modelID: "gemini-3.7-flash", variant: "default" },
    )
    expect(current).toEqual({ providerID: "jolli-google", modelID: "gemini-3.7-flash" })
    expect(variant).toBeUndefined()
  })

  test("keeps a newer manual selection", () => {
    let changed = false
    syncAcceptedModel(
      {
        model: {
          current: () => ({ providerID: "jolli-openai", modelID: "gpt-5.6-terra" }),
          set: () => {
            changed = true
          },
          variant: {
            set: () => {
              changed = true
            },
          },
        },
      },
      { providerID: "jolli-anthropic", modelID: "claude-opus-5" },
      { providerID: "jolli-google", modelID: "gemini-3.7-flash" },
    )
    expect(changed).toBe(false)
  })

  test("does not change the variant when the suggested model cannot be selected", () => {
    let variant = "high"
    syncAcceptedModel(
      {
        model: {
          current: () => ({ providerID: "jolli-anthropic", modelID: "claude-opus-5" }),
          set: () => {},
          variant: { set: (value) => (variant = value ?? "") },
        },
      },
      { providerID: "jolli-anthropic", modelID: "claude-opus-5" },
      { providerID: "jolli-google", modelID: "gemini-3.7-flash" },
    )
    expect(variant).toBe("high")
  })
})
