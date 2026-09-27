import { Config, ConfigProvider, Context, Effect, Layer, Option } from "effect"
import { envConfig } from "@opencode-ai/core/flag/flag"
import { ConfigService } from "@/effect/config-service"

// Names are suffixes: bool("PURE") reads JOLLICODE_PURE, falling back to OPENCODE_PURE.
const bool = (suffix: string) => envConfig(Config.boolean, suffix).pipe(Config.withDefault(false))
const positiveInteger = (suffix: string) =>
  envConfig(Config.number, suffix).pipe(
    Config.map((value) => (Number.isInteger(value) && value > 0 ? value : undefined)),
    Config.orElse(() => Config.succeed(undefined)),
  )
const experimental = bool("EXPERIMENTAL")
const enabledByExperimental = (suffix: string) =>
  Config.all({ experimental, enabled: envConfig(Config.boolean, suffix).pipe(Config.option) }).pipe(
    Config.map((flags) => Option.getOrElse(flags.enabled, () => flags.experimental)),
  )

export class Service extends ConfigService.Service<Service>()("@opencode/RuntimeFlags", {
  autoShare: bool("AUTO_SHARE"),
  lockdown: bool("LOCKDOWN"),
  pure: bool("PURE"),
  disableDefaultPlugins: bool("DISABLE_DEFAULT_PLUGINS"),
  disableEmbeddedWebUi: bool("DISABLE_EMBEDDED_WEB_UI"),
  disableExternalSkills: bool("DISABLE_EXTERNAL_SKILLS"),
  disableLspDownload: bool("DISABLE_LSP_DOWNLOAD"),
  disableClaudeCodePrompt: Config.all({
    broad: bool("DISABLE_CLAUDE_CODE"),
    direct: bool("DISABLE_CLAUDE_CODE_PROMPT"),
  }).pipe(Config.map((flags) => flags.broad || flags.direct)),
  disableClaudeCodeSkills: Config.all({
    broad: bool("DISABLE_CLAUDE_CODE"),
    direct: bool("DISABLE_CLAUDE_CODE_SKILLS"),
  }).pipe(Config.map((flags) => flags.broad || flags.direct)),
  enableExa: Config.all({
    experimental,
    enabled: bool("ENABLE_EXA"),
    legacy: bool("EXPERIMENTAL_EXA"),
  }).pipe(Config.map((flags) => flags.experimental || flags.enabled || flags.legacy)),
  enableParallel: Config.all({
    enabled: bool("ENABLE_PARALLEL"),
    legacy: bool("EXPERIMENTAL_PARALLEL"),
  }).pipe(Config.map((flags) => flags.enabled || flags.legacy)),
  enableExperimentalModels: bool("ENABLE_EXPERIMENTAL_MODELS"),
  enableQuestionTool: bool("ENABLE_QUESTION_TOOL"),
  experimentalReferences: enabledByExperimental("EXPERIMENTAL_REFERENCES"),
  experimentalBackgroundSubagents: enabledByExperimental("EXPERIMENTAL_BACKGROUND_SUBAGENTS"),
  experimentalLspTy: bool("EXPERIMENTAL_LSP_TY"),
  experimentalLspTool: enabledByExperimental("EXPERIMENTAL_LSP_TOOL"),
  experimentalOxfmt: enabledByExperimental("EXPERIMENTAL_OXFMT"),
  experimentalPlanMode: enabledByExperimental("EXPERIMENTAL_PLAN_MODE"),
  experimentalCodeMode: enabledByExperimental("EXPERIMENTAL_CODE_MODE"),
  experimentalEventSystem: enabledByExperimental("EXPERIMENTAL_EVENT_SYSTEM"),
  experimentalWorkspaces: enabledByExperimental("EXPERIMENTAL_WORKSPACES"),
  experimentalIconDiscovery: enabledByExperimental("EXPERIMENTAL_ICON_DISCOVERY"),
  outputTokenMax: positiveInteger("EXPERIMENTAL_OUTPUT_TOKEN_MAX"),
  bashDefaultTimeoutMs: positiveInteger("EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS"),
  experimentalNativeLlm: bool("EXPERIMENTAL_NATIVE_LLM"),
  experimentalWebSockets: bool("EXPERIMENTAL_WEBSOCKETS"),
  client: envConfig(Config.string, "CLIENT").pipe(Config.withDefault("cli")),
}) {}

export type Info = Context.Service.Shape<typeof Service>

const emptyConfigLayer = Service.layer.pipe(
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
  Layer.orDie,
)

export const layer = (overrides: Partial<Info> = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const flags = yield* Service
      return Service.of({ ...flags, ...overrides })
    }),
  ).pipe(Layer.provide(emptyConfigLayer))

export const node = LayerNode.make({ service: Service, layer: Service.layer.pipe(Layer.orDie), deps: [] })

export * as RuntimeFlags from "./runtime-flags"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
