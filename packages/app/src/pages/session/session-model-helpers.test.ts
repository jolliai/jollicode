import { describe, expect, test } from "bun:test"
import type { UserMessage } from "@opencode-ai/sdk/v2"
import {
  applyPendingModelVariant,
  resetSessionModel,
  restorePromptModel,
  syncAcceptedMessageModel,
  syncAcceptedSessionModel,
  syncPromptModel,
  syncSessionModel,
} from "./session-model-helpers"

const message = (input?: { agent?: string; model?: UserMessage["model"] }) =>
  ({
    id: "msg",
    sessionID: "session",
    role: "user",
    time: { created: 1 },
    agent: input?.agent ?? "build",
    model: input?.model ?? { providerID: "anthropic", modelID: "claude-sonnet-4" },
  }) as UserMessage

describe("syncSessionModel", () => {
  test("restores the last message through session state", () => {
    const calls: unknown[] = []

    syncSessionModel(
      {
        session: {
          restore(value) {
            calls.push(value)
          },
          reset() {},
        },
      },
      message({ model: { providerID: "anthropic", modelID: "claude-sonnet-4", variant: "high" } }),
    )

    expect(calls).toEqual([
      message({ model: { providerID: "anthropic", modelID: "claude-sonnet-4", variant: "high" } }),
    ])
  })
})

describe("syncAcceptedSessionModel", () => {
  test("updates the selection and clears the old variant after an automatic model switch", () => {
    const calls: unknown[] = []
    let current = { id: "gpt-5", provider: { id: "openai" } }
    syncAcceptedSessionModel(
      {
        model: {
          current: () => current,
          set: (model) => {
            calls.push(model)
            current = { id: model.modelID, provider: { id: model.providerID } }
          },
          variant: { current: () => "high", set: (variant) => calls.push(variant) },
        },
      },
      { id: "gpt-5", providerID: "openai" },
      { id: "claude-opus-5", providerID: "anthropic", variant: "default" },
    )
    expect(calls).toEqual([{ providerID: "anthropic", modelID: "claude-opus-5" }, undefined])
  })

  test("defers the new variant without clearing the old model variant", () => {
    const calls: unknown[] = []
    let current = { id: "gpt-5", provider: { id: "openai" } }
    const local = {
      model: {
        current: () => current,
        set: (model: { providerID: string; modelID: string }) => calls.push(model),
        variant: { current: () => "high", set: (variant: string | undefined) => calls.push(variant) },
      },
    }

    const pending = syncAcceptedSessionModel(
      local,
      { id: "gpt-5", providerID: "openai" },
      { id: "claude-opus-5", providerID: "anthropic", variant: "default" },
    )

    expect(calls).toEqual([{ providerID: "anthropic", modelID: "claude-opus-5" }])
    expect(applyPendingModelVariant(local, pending)).toBe(false)
    current = { id: "claude-opus-5", provider: { id: "anthropic" } }
    expect(applyPendingModelVariant(local, pending)).toBe(true)
    expect(calls).toEqual([{ providerID: "anthropic", modelID: "claude-opus-5" }, undefined])
  })

  test("keeps a newer manual selection", () => {
    const calls: unknown[] = []
    syncAcceptedSessionModel(
      {
        model: {
          current: () => ({ id: "gemini-3", provider: { id: "google" } }),
          set: (model) => calls.push(model),
          variant: { current: () => undefined, set: (variant) => calls.push(variant) },
        },
      },
      { id: "gpt-5", providerID: "openai" },
      { id: "claude-opus-5", providerID: "anthropic" },
    )
    expect(calls).toEqual([])
  })
})

describe("syncAcceptedMessageModel", () => {
  test("updates the selection when the current user message changes model in place", () => {
    const calls: unknown[] = []
    syncAcceptedMessageModel(
      {
        model: {
          current: () => ({ id: "gpt-5", provider: { id: "openai" } }),
          set: (model) => calls.push(model),
          variant: { current: () => "high", set: (variant) => calls.push(variant) },
        },
      },
      { providerID: "openai", modelID: "gpt-5", variant: "high" },
      { providerID: "anthropic", modelID: "claude-opus-5" },
    )
    expect(calls).toEqual([{ providerID: "anthropic", modelID: "claude-opus-5" }, undefined])
  })
})

describe("resetSessionModel", () => {
  test("clears draft session state", () => {
    const calls: string[] = []

    resetSessionModel({
      session: {
        reset() {
          calls.push("reset")
        },
        restore() {},
      },
    })

    expect(calls).toEqual(["reset"])
  })
})

describe("syncPromptModel", () => {
  test("stores the effective session model in prompt state", () => {
    const calls: unknown[] = []

    syncPromptModel(
      {
        model: {
          current: () => ({ id: "claude-sonnet-4", provider: { id: "anthropic" } }),
          set() {},
          variant: { current: () => "high", set() {} },
        },
      },
      {
        model: {
          current: () => undefined,
          set: (model) => calls.push(model),
        },
      },
    )

    expect(calls).toEqual([{ providerID: "anthropic", modelID: "claude-sonnet-4", variant: "high" }])
  })

  test("does not rewrite an unchanged prompt model", () => {
    const calls: unknown[] = []
    const model = { providerID: "anthropic", modelID: "claude-sonnet-4", variant: "high" }

    syncPromptModel(
      {
        model: {
          current: () => ({ id: model.modelID, provider: { id: model.providerID } }),
          set() {},
          variant: { current: () => model.variant, set() {} },
        },
      },
      {
        model: {
          current: () => model,
          set: (value) => calls.push(value),
        },
      },
    )

    expect(calls).toEqual([])
  })
})

describe("restorePromptModel", () => {
  test("restores the persisted prompt model into session selection", () => {
    const calls: unknown[] = []
    const restored = restorePromptModel(
      {
        model: {
          current: () => ({ id: "gpt", provider: { id: "openai" } }),
          set: (model) => calls.push(model),
          variant: {
            current: () => undefined,
            set: (variant) => calls.push(variant),
          },
        },
      },
      {
        model: {
          current: () => ({ providerID: "anthropic", modelID: "claude", variant: "high" }),
          set() {},
        },
      },
    )

    expect(restored).toBe(true)
    expect(calls).toEqual([{ providerID: "anthropic", modelID: "claude" }, "high"])
  })

  test("does nothing without a persisted prompt model", () => {
    const calls: unknown[] = []
    const restored = restorePromptModel(
      {
        model: {
          current: () => ({ id: "gpt", provider: { id: "openai" } }),
          set: (model) => calls.push(model),
          variant: {
            current: () => undefined,
            set: (variant) => calls.push(variant),
          },
        },
      },
      {
        model: {
          current: () => undefined,
          set() {},
        },
      },
    )

    expect(restored).toBe(false)
    expect(calls).toEqual([])
  })
})
