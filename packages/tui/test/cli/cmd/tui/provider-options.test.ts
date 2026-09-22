import { describe, expect, test } from "bun:test"
import { Brand } from "@opencode-ai/core/brand"
import { providerIdFor } from "@opencode-ai/core/jolli/gateway-config"
import { connectAction, providerOptions } from "../../../../src/component/dialog-provider"

describe("providerOptions", () => {
  test("offers no way to attach a provider of one's own", () => {
    // Upstream ends the list with a synthetic "Other" row that prompts for a provider id and writes
    // a credential for it, bypassing `enabled_providers` entirely. That row is the model lockdown's
    // only hole, so its absence is asserted rather than assumed.
    const values = providerOptions([{ id: "openai", name: "OpenAI" }]).map((option) => option.value)
    expect(values).toEqual(["openai"])
  })

  test("does not use Other as the generic provider category", () => {
    expect(providerOptions([{ id: "mistral", name: "Mistral" }])[0]?.category).toBe("Providers")
  })

  test("puts Jolli first, then the popular providers, then the rest alphabetically", () => {
    expect(
      providerOptions([
        { id: "openai", name: "OpenAI" },
        { id: "custom-z", name: "Zebra Provider" },
        { id: Brand.short, name: "Jolli" },
        { id: "anthropic", name: "Anthropic" },
        { id: "mistral", name: "Mistral" },
        { id: "aws", name: "AWS Bedrock" },
      ]).map((option) => option.value),
    ).toEqual([Brand.short, "openai", "anthropic", "aws", "mistral", "custom-z"])
  })

  test("categorises Jolli as popular and describes it", () => {
    expect(providerOptions([{ id: Brand.short, name: "Jolli" }])[0]).toMatchObject({
      category: "Popular",
      description: "Your school account",
    })
  })
})

describe("connectAction", () => {
  const methods = [{ type: "oauth" as const, label: "Sign in to Jolli" }]
  // A sign-in reports as connected under the protocol provider ids, never the bare auth id.
  const connected = [providerIdFor("anthropic")]

  test("signs the student in when Jolli is the only provider and nothing is connected yet", () => {
    // Signed out the provider list is genuinely empty — Jolli is not in models.dev, so it enters
    // the list only once a credential exists. The auth methods are what is left to key off.
    expect(connectAction({ providerIDs: [], methods, connected: [] })).toBe("login")
  })

  test("does not send an already signed-in student back out to a browser", () => {
    // The whole dialog would otherwise render nothing while a new sign-in tab opened behind it.
    expect(connectAction({ providerIDs: [Brand.short], methods, connected })).toBe("signed-in")
  })

  test("still shows the picker when there is more than one provider to pick", () => {
    expect(connectAction({ providerIDs: [Brand.short, "openai"], methods, connected })).toBe("pick")
    expect(connectAction({ providerIDs: ["openai"], methods, connected: [] })).toBe("pick")
  })

  test("shows the picker rather than a sign-in the plugin registry cannot start", () => {
    // No declared auth method means nothing to launch; an empty dialog beats a silent no-op.
    expect(connectAction({ providerIDs: [], methods: undefined, connected: [] })).toBe("pick")
  })
})
