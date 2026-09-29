import { expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { jolliBaseConfig, type JolliModel } from "@opencode-ai/core/jolli/gateway-config"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect } from "effect"
import { Env } from "../../src/env"
import { Plugin } from "../../src/plugin/index"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

/**
 * Media on the Jolli gateway's own models, which are declared from config rather than models.dev,
 * so nothing but the gateway catalogue can tell opencode what they read.
 *
 * Built through the real provider layer from `jolliBaseConfig`, because the regressions this
 * guards against came from how such a model's capabilities resolve, which a hand-written model
 * object would simply assert.
 */
const it = testEffect(LayerNode.compile(LayerNode.group([Provider.node, Env.node, Plugin.node])))

const TOOL_IMAGE = "VE9PTElNRw=="
const PASTED_IMAGE = "UEFTVEVE"
const sessionID = SessionID.make("session")

function configFor(models: ReadonlyArray<JolliModel>) {
  const config = jolliBaseConfig({ signedIn: true, baseUrl: "https://acme.jolli.ai", models: { anthropic: models } })
  // The real credential reaches the provider through the Jolli plugin's own fetch; a key here only
  // lets the test's provider list include the block.
  const provider = config.provider?.[ProviderV2.ID.make("jolli-anthropic")]
  return provider
    ? { ...config, provider: { "jolli-anthropic": { ...provider, options: { ...provider.options, apiKey: "test" } } } }
    : config
}

function part(messageID: string, id: string) {
  return { id: PartID.make(`prt_${id}`), sessionID, messageID: MessageID.make(`msg_${messageID}`) }
}

function history(model: Provider.Model): SessionV1.WithParts[] {
  return [
    {
      info: { id: "u1", sessionID, role: "user", time: { created: 0 }, agent: "user", mode: "", tools: {} } as never,
      parts: [
        { ...part("u1", "t1"), type: "text", text: "what does this show?" },
        {
          ...part("u1", "f1"),
          type: "file",
          mime: "image/png",
          filename: "pasted.png",
          url: `data:image/png;base64,${PASTED_IMAGE}`,
        },
      ] as SessionV1.Part[],
    },
    {
      info: {
        id: "a1",
        sessionID,
        role: "assistant",
        time: { created: 0 },
        parentID: "u1",
        modelID: model.api.id,
        providerID: model.providerID,
        mode: "",
        agent: "agent",
        path: { cwd: "/", root: "/" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      } as never,
      parts: [
        {
          ...part("a1", "tool1"),
          type: "tool",
          callID: "call-1",
          tool: "read",
          state: {
            status: "completed",
            input: { filePath: "/repo/diagram.png" },
            output: "Image read successfully",
            title: "diagram.png",
            metadata: {},
            time: { start: 0, end: 1 },
            attachments: [
              { ...part("a1", "att1"), type: "file", mime: "image/png", url: `data:image/png;base64,${TOOL_IMAGE}` },
            ],
          },
        },
      ] as SessionV1.Part[],
    },
  ]
}

const sent = Effect.fn(function* (modelID: string) {
  const providers = yield* Provider.use.list()
  const model = providers[ProviderV2.ID.make("jolli-anthropic")]?.models[ModelV2.ID.make(modelID)]
  if (!model) throw new Error(`the Jolli model ${modelID} was not declared`)
  const messages = yield* Effect.promise(() => MessageV2.toModelMessages(history(model), model))
  return JSON.stringify(ProviderTransform.message(messages, model, {}))
})

it.instance(
  "keeps a tool result's image for a Jolli model whose catalogue states nothing about its input",
  Effect.gen(function* () {
    const request = yield* sent("uuid-unstated")

    expect(request).toContain(TOOL_IMAGE)
    expect(request).not.toContain("Cannot read image")
  }),
  { config: configFor([{ id: "uuid-unstated", name: "claude-sonnet-5" }]) },
)

it.instance(
  "sends a pasted image to a Jolli model the catalogue says reads images",
  Effect.gen(function* () {
    const request = yield* sent("uuid-vision")

    expect(request).toContain(PASTED_IMAGE)
    expect(request).toContain(TOOL_IMAGE)
    expect(request).not.toContain("does not support image input")
  }),
  { config: configFor([{ id: "uuid-vision", name: "claude-sonnet-5", inputModalities: ["text", "image", "pdf"] }]) },
)
