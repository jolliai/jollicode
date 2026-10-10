import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { llmClient } from "@opencode-ai/core/effect/app-node-platform"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Provider } from "@/provider/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Context, Effect, Layer } from "effect"
import * as Stream from "effect/Stream"
import { APICallError, streamText, wrapLanguageModel, type ModelMessage, type Tool } from "ai"
import type { LLMEvent } from "@opencode-ai/llm"
import { LLMClient } from "@opencode-ai/llm/route"
import type { LLMClientService } from "@opencode-ai/llm/route"
import { GitLabWorkflowLanguageModel } from "gitlab-ai-provider"
import { ProviderTransform } from "@/provider/transform"
import { Config } from "@/config/config"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "./message-v2"
import { Plugin } from "@/plugin"
import { Permission } from "@/permission"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@opencode-ai/core/event"
import { Wildcard } from "@/util/wildcard"
import { SessionID } from "@/session/schema"
import { Auth } from "@/auth"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { LLMAISDK } from "./llm/ai-sdk"
import { LLMNativeRuntime } from "./llm/native-runtime"
import { LLMRequestPrep } from "./llm/request"
import {
  isJolliProviderId,
  isSupportedProtocol,
  providerIdFor,
  SUPPORTED_PROTOCOLS,
  type SupportedProtocol,
} from "@opencode-ai/core/jolli/gateway-config"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

const ModelSwitchReasonSchema = Schema.Literals(["provider_busy", "provider_unavailable", "model_unavailable"])
const ModelSwitchProtocolSchema = Schema.Literals(SUPPORTED_PROTOCOLS)
// The gateway's `requiresConfirmation` and `upstreamModelName` used to be parsed
// here too, but the client always confirms a change of model id or provider id
// on its own (a switch by definition changes at least one), so the gateway hint
// never flipped the decision. Dropped from the schema so a reader does not
// mistake the field for something the client honours. If the gateway later needs
// to opt OUT of confirmation for a same-model failover, that is a real change
// to the client-side gate, not just a body field.
const ModelSwitchBodySchema = Schema.fromJsonString(
  Schema.Struct({
    code: Schema.Literal("jolli_model_switch"),
    provider: ModelSwitchProtocolSchema,
    model: Schema.String,
    reason: Schema.optional(ModelSwitchReasonSchema),
  }),
)
const decodeModelSwitchBody = Schema.decodeUnknownOption(ModelSwitchBodySchema)

function modelSwitch(error: unknown):
  | {
      provider: SupportedProtocol
      model: string
      reason?: "provider_busy" | "provider_unavailable" | "model_unavailable"
    }
  | undefined {
  if (!APICallError.isInstance(error) || error.statusCode !== 409 || !error.responseBody) return undefined
  const parsed = decodeModelSwitchBody(error.responseBody)
  if (Option.isNone(parsed)) return undefined
  const body = parsed.value
  return {
    provider: body.provider,
    model: body.model,
    ...(body.reason !== undefined ? { reason: body.reason } : {}),
  }
}

export const OUTPUT_TOKEN_MAX = ProviderTransform.OUTPUT_TOKEN_MAX

export type PreparedModelInput = {
  user: SessionV1.User
  system: string[]
  messages: ModelMessage[]
  tools: Record<string, Tool>
  mcpToolServers?: ReadonlyMap<string, string>
}

export type StreamInput = PreparedModelInput & {
  sessionID: string
  parentSessionID?: string
  turnID?: string
  clientAttemptID?: string
  stepIndex?: number
  courseID?: string
  courseAssistantID?: string
  /** The turn only carries on with the previous one, after compaction; see `SessionPrompt.continuesTurn`. */
  continuesTurn?: boolean
  toolErrors?: ReadonlyArray<string>
  model: Provider.Model
  agent: Agent.Info
  permission?: PermissionV1.Ruleset
  small?: boolean
  retries?: number
  toolChoice?: "auto" | "required" | "none"
  onModelSwitch?: (model: Provider.Model) => Effect.Effect<void, unknown>
  onModelSwitchPrepare?: (model: Provider.Model) => Effect.Effect<PreparedModelInput, unknown>
  onModelSwitchProposal?: (
    model: Provider.Model,
    reason: "provider_busy" | "provider_unavailable" | "model_unavailable",
  ) => Effect.Effect<boolean, unknown>
}

export type StreamRequest = StreamInput & {
  abort: AbortSignal
  onResponseHeaders?: (headers: Readonly<Record<string, string>> | undefined) => Effect.Effect<void, unknown>
}

export interface Interface {
  readonly stream: (input: StreamInput) => Stream.Stream<LLMEvent, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LLM") {}

export const use = serviceUse(Service)

const live: Layer.Layer<
  Service,
  never,
  | Auth.Service
  | Config.Service
  | Provider.Service
  | Plugin.Service
  | Permission.Service
  | EventV2Bridge.Service
  | LLMClientService
  | RuntimeFlags.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    const plugin = yield* Plugin.Service
    const perm = yield* Permission.Service
    const events = yield* EventV2Bridge.Service
    const llmClient = yield* LLMClient.Service
    const flags = yield* RuntimeFlags.Service

    const run = Effect.fn("LLM.run")(function* (input: StreamRequest) {
      yield* Effect.logInfo("stream", {
        providerID: input.model.providerID,
        modelID: input.model.id,
        "session.id": input.sessionID,
        small: (input.small ?? false).toString(),
        agent: input.agent.name,
        mode: input.agent.mode,
      })

      const [language, cfg, item, info] = yield* Effect.all(
        [
          provider.getLanguage(input.model),
          config.get(),
          provider.getProvider(input.model.providerID),
          auth.get(input.model.providerID),
        ],
        { concurrency: "unbounded" },
      )

      const isWorkflow = language instanceof GitLabWorkflowLanguageModel
      const prepared = yield* LLMRequestPrep.prepare({
        ...input,
        provider: item,
        auth: info,
        plugin,
        flags,
        isWorkflow,
      })

      // Wire up toolExecutor for DWS workflow models so that tool calls
      // from the workflow service are executed via opencode's tool system
      // and results sent back over the WebSocket.
      const bridge = yield* EffectBridge.make()
      if (language instanceof GitLabWorkflowLanguageModel) {
        const workflowModel = language as GitLabWorkflowLanguageModel & {
          sessionID?: string
          sessionPreapprovedTools?: string[]
          approvalHandler?: (approvalTools: { name: string; args: string }[]) => Promise<{ approved: boolean }>
        }
        workflowModel.sessionID = input.sessionID
        workflowModel.systemPrompt = prepared.system.join("\n")
        workflowModel.toolExecutor = async (toolName, argsJson, _requestID) => {
          const t = prepared.tools[toolName]
          if (!t || !t.execute) {
            return { result: "", error: `Unknown tool: ${toolName}` }
          }
          try {
            const result = await t.execute!(JSON.parse(argsJson), {
              toolCallId: _requestID,
              messages: input.messages,
              abortSignal: input.abort,
            })
            const output = typeof result === "string" ? result : (result?.output ?? JSON.stringify(result))
            return {
              result: output,
              metadata: typeof result === "object" ? result?.metadata : undefined,
              title: typeof result === "object" ? result?.title : undefined,
            }
          } catch (e: any) {
            return { result: "", error: e.message ?? String(e) }
          }
        }

        const ruleset = Permission.merge(input.agent.permission ?? [], input.permission ?? [])
        workflowModel.sessionPreapprovedTools = Object.keys(prepared.tools).filter((name) => {
          const match = ruleset.findLast((rule) => Wildcard.match(name, rule.permission))
          return !match || match.action !== "ask"
        })

        const approvedToolsForSession = new Set<string>()
        workflowModel.approvalHandler = bridge.bind(async (approvalTools) => {
          const uniqueNames = [...new Set(approvalTools.map((t: { name: string }) => t.name))] as string[]
          // Auto-approve tools that were already approved in this session
          // (prevents infinite approval loops for server-side MCP tools)
          if (uniqueNames.every((name) => approvedToolsForSession.has(name))) {
            return { approved: true }
          }

          const id = PermissionV1.ID.ascending()
          let unsub: EventV2.Unsubscribe | undefined
          try {
            unsub = await bridge.promise(
              events.listen((event) => {
                if (event.type !== Permission.Event.Replied.type) return Effect.void
                const data = event.data as EventV2.Data<typeof Permission.Event.Replied>
                if (data.requestID !== id) return Effect.void
                void data.reply
                return Effect.void
              }),
            )
            const toolPatterns = approvalTools.map((t: { name: string; args: string }) => {
              try {
                const parsed = JSON.parse(t.args) as Record<string, unknown>
                const title = (parsed?.title ?? parsed?.name ?? "") as string
                return title ? `${t.name}: ${title}` : t.name
              } catch {
                return t.name
              }
            })
            const uniquePatterns = [...new Set(toolPatterns)] as string[]
            await bridge.promise(
              perm.ask({
                id,
                sessionID: SessionID.make(input.sessionID),
                permission: "workflow_tool_approval",
                patterns: uniquePatterns,
                metadata: { tools: approvalTools },
                always: uniquePatterns,
                ruleset: [],
              }),
            )
            for (const name of uniqueNames) approvedToolsForSession.add(name)
            workflowModel.sessionPreapprovedTools = [...(workflowModel.sessionPreapprovedTools ?? []), ...uniqueNames]
            return { approved: true }
          } catch {
            return { approved: false }
          } finally {
            if (unsub) await bridge.promise(unsub)
          }
        })
      }

      const tracer = cfg.experimental?.openTelemetry
        ? Option.getOrUndefined(yield* Effect.serviceOption(OtelTracer.OtelTracer))
        : undefined
      const telemetryTracer = tracer
        ? new Proxy(tracer, {
            get(target, prop, receiver) {
              if (prop !== "startSpan") return Reflect.get(target, prop, receiver)
              return (...args: Parameters<typeof target.startSpan>) => {
                const span = target.startSpan(...args)
                span.setAttribute("session.id", input.sessionID)
                return span
              }
            },
          })
        : undefined

      // Runtime seam: native is an opt-in adapter over @opencode-ai/llm. It
      // either returns a ready LLMEvent stream or a concrete fallback reason.
      //
      // ⚠ Jolli providers are excluded from the native runtime here, not because
      // native cannot serve them, but because the gateway's model-switch mechanism
      // (`modelSwitch()` on a 409 body, and the `x-jolli-served-*` response
      // headers below) is currently only wired through the AI SDK code path
      // (`APICallError.isInstance` for the 409 and `result.result.response` for
      // the headers). The native path returns a raw LLMEvent stream that has no
      // equivalent hooks, so a Jolli provider on the native runtime would never
      // see a switch and would silently keep talking to the original model.
      //
      // This is a design trade-off, NOT a bug: the coupling is intentional until
      // the switch protocol is lifted out of the AI SDK adapter. A future refactor
      // could either (a) expose the two switch signals through the LLMEvent
      // stream so both runtimes handle them uniformly, or (b) put the switch
      // detection in the transport layer beneath both runtimes. Either lets Jolli
      // providers take the native path without silently losing failover.
      if (flags.experimentalNativeLlm && !isJolliProviderId(input.model.providerID)) {
        const native = LLMNativeRuntime.stream({
          model: input.model,
          provider: item,
          auth: info,
          llmClient,
          messages: prepared.messages,
          tools: prepared.tools,
          toolChoice: input.toolChoice,
          temperature: prepared.params.temperature,
          topP: prepared.params.topP,
          topK: prepared.params.topK,
          maxOutputTokens: prepared.params.maxOutputTokens,
          providerOptions: prepared.params.options,
          headers: prepared.headers,
          abort: input.abort,
        })
        if (native.type === "supported") {
          yield* Effect.logInfo("llm runtime selected", {
            "llm.runtime": "native",
            "llm.provider": input.model.providerID,
            "llm.model": input.model.id,
          })
          return {
            type: "native" as const,
            stream: native.stream,
          }
        }
        yield* Effect.logInfo("llm runtime selected", {
          "llm.runtime": "ai-sdk",
          "llm.provider": input.model.providerID,
          "llm.model": input.model.id,
          "llm.native_unsupported_reason": native.reason,
        })
        yield* Effect.logInfo("native runtime unavailable; falling back to ai-sdk", {
          providerID: input.model.providerID,
          modelID: input.model.id,
          "session.id": input.sessionID,
          small: (input.small ?? false).toString(),
          agent: input.agent.name,
          mode: input.agent.mode,
          reason: native.reason,
        })
      }

      yield* Effect.logInfo("llm runtime selected", {
        "llm.runtime": "ai-sdk",
        "llm.provider": input.model.providerID,
        "llm.model": input.model.id,
      })
      // Default runtime path: AI SDK owns provider execution and tool dispatch;
      // LLMAISDK.toLLMEvents below normalizes fullStream parts for the processor.
      return {
        type: "ai-sdk" as const,
        result: streamText({
          onError(error) {
            bridge.fork(
              Effect.logError("stream error", {
                providerID: input.model.providerID,
                modelID: input.model.id,
                "session.id": input.sessionID,
                small: (input.small ?? false).toString(),
                agent: input.agent.name,
                mode: input.agent.mode,
                error,
              }),
            )
          },
          // Copilot returns the authoritative billed amount only in provider-specific response fields.
          includeRawChunks: input.model.providerID.includes("github-copilot"),
          async experimental_repairToolCall(failed) {
            const lower = failed.toolCall.toolName.toLowerCase()
            if (lower !== failed.toolCall.toolName && prepared.tools[lower]) {
              return {
                ...failed.toolCall,
                toolName: lower,
              }
            }
            return {
              ...failed.toolCall,
              input: JSON.stringify({
                tool: failed.toolCall.toolName,
                error: failed.error.message,
              }),
              toolName: "invalid",
            }
          },
          temperature: prepared.params.temperature,
          topP: prepared.params.topP,
          topK: prepared.params.topK,
          providerOptions: ProviderTransform.providerOptions(input.model, prepared.params.options),
          activeTools: Object.keys(prepared.tools).filter((x) => x !== "invalid"),
          tools: prepared.tools,
          toolChoice: input.toolChoice,
          maxOutputTokens: prepared.params.maxOutputTokens,
          abortSignal: input.abort,
          headers: prepared.headers,
          maxRetries: input.retries ?? 0,
          messages: prepared.messages,
          model: wrapLanguageModel({
            model: language,
            middleware: [
              {
                specificationVersion: "v3" as const,
                async transformParams(args) {
                  if (args.type === "stream") {
                    // @ts-expect-error
                    args.params.prompt = ProviderTransform.message(
                      args.params.prompt,
                      input.model,
                      prepared.messageTransformOptions,
                    )
                  }
                  return args.params
                },
                async wrapStream({ doStream }) {
                  const result = await doStream()
                  if (input.onResponseHeaders) {
                    await bridge.promise(input.onResponseHeaders(result.response?.headers))
                  }
                  return result
                },
              },
            ],
          }),
          experimental_telemetry: {
            isEnabled: cfg.experimental?.openTelemetry,
            functionId: "session.llm",
            tracer: telemetryTracer,
            metadata: {
              userId: cfg.username ?? "unknown",
              sessionId: input.sessionID,
            },
          },
        }),
      }
    })

    const streamAttempt = (input: StreamInput, seen: ReadonlySet<string>): Stream.Stream<LLMEvent, unknown> => {
      let emitted = false
      let pendingStart: LLMEvent | undefined
      let servedModelKey = `${input.model.providerID}/${input.model.id}`
      return Stream.scoped(
        Stream.unwrap(
          Effect.gen(function* () {
            const ctrl = yield* Effect.acquireRelease(
              Effect.sync(() => new AbortController()),
              (ctrl) => Effect.sync(() => ctrl.abort()),
            )

            const result = yield* run({
              ...input,
              abort: ctrl.signal,
              onResponseHeaders:
                isJolliProviderId(input.model.providerID) && input.onModelSwitch
                  ? (headers) =>
                      Effect.gen(function* () {
                        const protocol = headers?.["x-jolli-served-provider"]
                        const modelID = headers?.["x-jolli-served-model"]
                        if (!isSupportedProtocol(protocol) || !modelID) return
                        const providerID = ProviderV2.ID.make(providerIdFor(protocol))
                        const key = `${providerID}/${modelID}`
                        if (key === servedModelKey) return
                        const model = yield* provider.getModel(providerID, ModelV2.ID.make(modelID)).pipe(Effect.option)
                        if (Option.isNone(model)) return
                        yield* input.onModelSwitch!(model.value)
                        servedModelKey = key
                      })
                  : undefined,
            })

            if (result.type === "native") return result.stream

            // Adapter seam: both runtimes expose the same LLMEvent stream. Native
            // already returns one; AI SDK streams are converted here.
            const state = LLMAISDK.adapterState()
            const events = Stream.fromAsyncIterable(result.result.fullStream, (e) =>
              e instanceof Error ? e : new Error(String(e)),
            ).pipe(
              Stream.mapEffect((event) => LLMAISDK.toLLMEvents(state, event)),
              Stream.flatMap((events) => Stream.fromIterable(events)),
              Stream.flatMap((event) => {
                if (event.type === "step-start" && !emitted) {
                  pendingStart = event
                  return Stream.empty
                }
                emitted = true
                const output = pendingStart ? [pendingStart, event] : [event]
                pendingStart = undefined
                return Stream.fromIterable(output)
              }),
            )
            return events
          }),
        ),
      ).pipe(
        Stream.catch((error) => {
          const target = modelSwitch(error)
          if (!target || emitted || !isJolliProviderId(input.model.providerID)) return Stream.fail(error)
          const providerID = ProviderV2.ID.make(providerIdFor(target.provider))
          const modelID = ModelV2.ID.make(target.model)
          const key = `${providerID}/${modelID}`
          if (seen.has(key)) return Stream.fail(error)
          return Stream.unwrap(
            Effect.gen(function* () {
              const nextModel = yield* provider
                .getModel(providerID, modelID)
                .pipe(Effect.catch(() => Effect.fail(error)))
              // A switch always changes either the model id or the provider id (that is
              // why the gateway asked), so the client always confirms. This used to be
              // an OR against `target.requiresConfirmation === true`, but since the two
              // client-side comparisons already dominate, the gateway flag never
              // changed the outcome. Removed the flag from the response schema so the
              // read here is not a misleading indirection over dead data.
              const requiresConfirmation =
                nextModel.id !== input.model.id || nextModel.providerID !== input.model.providerID
              if (requiresConfirmation) {
                if (!input.onModelSwitchProposal) return yield* Effect.fail(error)
                const approved = yield* input.onModelSwitchProposal(nextModel, target.reason ?? "model_unavailable")
                if (!approved)
                  return yield* Effect.fail(new Error("Model switch cancelled. Your message was not resent."))
              }
              if (!input.onModelSwitchPrepare) return yield* Effect.fail(error)
              const prepared = yield* input.onModelSwitchPrepare(nextModel)
              yield* Effect.logInfo("gateway model switch", { from: input.model.id, to: nextModel.id, providerID })
              return streamAttempt({ ...input, ...prepared, model: nextModel }, new Set([...seen, key]))
            }),
          )
        }),
      )
    }

    const stream: Interface["stream"] = (input) =>
      streamAttempt(input, new Set([`${input.model.providerID}/${input.model.id}`]))

    return Service.of({ stream })
  }),
)

export const hasToolCalls = LLMRequestPrep.hasToolCalls

export const node = LayerNode.make({
  service: Service,
  layer: live,
  deps: [
    Auth.node,
    Config.node,
    Provider.node,
    Plugin.node,
    Permission.node,
    EventV2Bridge.node,
    llmClient,
    RuntimeFlags.node,
  ],
})

export * as LLM from "./llm"
