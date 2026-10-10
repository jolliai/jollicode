import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import path from "path"
import { pathToFileURL } from "url"
import os from "os"
import { mergeDeep } from "remeda"
import { Global } from "@opencode-ai/core/global"
import fsNode from "fs/promises"
import { Flag, envKey } from "@opencode-ai/core/flag/flag"
import { Auth } from "../auth"
import { Env } from "../env"
import { applyEdits, modify } from "jsonc-parser"
import { InstallationLocal, InstallationVersion } from "@opencode-ai/core/installation/version"
import { existsSync } from "fs"
import { Account } from "@/account/account"
import { isRecord } from "@/util/record"
import type { ConsoleState } from "@opencode-ai/core/v1/config/console-state"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { Clock, Context, Duration, Effect, Exit, Fiber, Layer, Option, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { containsPath, type InstanceContext } from "../project/instance-context"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { RemoteAuthError } from "@opencode-ai/core/v1/config/error"
import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"
import { ConfigPluginV1 } from "@opencode-ai/core/v1/config/plugin"
import { ConfigAgent } from "./agent"
import { ConfigCommand } from "./command"
import { ConfigManaged } from "./managed"
import { ConfigParse } from "./parse"
import { ConfigPaths } from "./paths"
import { ConfigPlugin } from "./plugin"
import { ConfigVariable } from "./variable"
import { ConfigV2Compat } from "./v2-compat"
import { Npm } from "@opencode-ai/core/npm"
import { Brand } from "@opencode-ai/core/brand"
import { JOLLI_PROVIDER_IDS, jolliBaseConfig } from "@opencode-ai/core/jolli/gateway-config"
import {
  type CatalogSnapshot,
  dropMcpConfigCache,
  loadCatalog,
  readMcpConfigCache,
  STARTUP_DEADLINE,
  writeMcpConfigCache,
} from "@opencode-ai/core/jolli/cache"
import { grantedModelIds, runnableModels, toProviderModels } from "@opencode-ai/core/jolli/catalog"
import { JolliSession } from "@opencode-ai/core/jolli/session"
import { fetchMcpConfig } from "@opencode-ai/core/jolli/api"
import { JOLLI_MCP_SERVER } from "@opencode-ai/core/jolli/mcp"
import { withTransientReadRetry } from "@/util/effect-http-client"

// Custom merge function that concatenates array fields instead of replacing them
// Keep remeda's deep conditional merge type out of hot config-loading paths; TS profiling showed it dominates here.
function mergeConfig(target: Info, source: Info): Info {
  return mergeDeep(target, source) as Info
}

function mergeConfigConcatArrays(target: Info, source: Info): Info {
  const merged = mergeConfig(target, source)
  if (target.instructions && source.instructions) {
    merged.instructions = Array.from(new Set([...target.instructions, ...source.instructions]))
  }
  return merged
}

/**
 * The provider models one loaded catalogue declares.
 *
 * ⚠ A MODEL THIS BUILD HAS NO PROVIDER FOR IS DROPPED, AND THIS WARNING IS THE ONLY TRACE OF IT. It
 * happens when the gateway starts serving a protocol a student's install predates. The picker then
 * offers fewer models than the course grants — none at all if every one is on that protocol, which
 * looks exactly like an empty catalogue — and nothing on screen says why, so support needs the log.
 *
 * ⚠ ONLY WHAT THE STUDENT'S COURSES GRANT COUNTS. The catalogue is the whole tenant's, and this runs
 * on every config load, so counting all of it warned every student on an older build — including
 * those whose picker the dropped models were never going to reach. No grant in force means every
 * model is reachable, so then every dropped one counts.
 */
const declaredModels = Effect.fnUntraced(function* (snapshot: CatalogSnapshot) {
  const runnable = runnableModels(snapshot.models)
  const granted = grantedModelIds(snapshot.assistants)
  const dropped = snapshot.models.filter((model) => !runnable.has(model.id) && (!granted || granted.has(model.id)))
  if (dropped.length > 0)
    yield* Effect.logWarning("Jolli: the catalogue offers models on protocols this build has no provider for", {
      protocols: Array.from(new Set(dropped.map((model) => model.protocol))),
      dropped: dropped.length,
      runnable: runnable.size,
    })
  return toProviderModels(runnable, granted)
})

/**
 * The Jolli floor for one stored credential: locked either way, with a provider once signed in.
 *
 * ⚠ THE MODEL LIST IS THE TENANT'S, FETCHED, AND ITS ABSENCE IS NOT AN ERROR. Which models exist is
 * the gateway's answer; `loadCatalog` serves it from a short-lived cache and falls back to a stale
 * one rather than to nothing. When even that is missing the provider is declared with NO models
 * rather than with a local list: the old `catalogModels()` fallback named models by name
 * (`claude-opus-4-8`) while a course grants them by Registry UUID, so mixing the two produced a
 * provider whose every model failed the course grant — an empty picker with no error to explain it.
 * An empty `models` block is the same emptiness, honestly arrived at.
 */
const jolliLockdownConfig = Effect.fnUntraced(function* (session: JolliSession.Interface) {
  // When the budget below starts running. Both network waits here are spent against the one deadline.
  const started = yield* Clock.currentTimeMillis
  /**
   * ⚠ RESOLVED BEFORE THE ROW IS READ, AND THAT ORDER IS DELIBERATE. `request()` renews a token
   * that is near expiry and removes the credential when the backend has retired it, so reading the
   * row first would let a just-revoked sign-in declare a provider block for one more config load.
   *
   * ⚠ IT CANNOT BE ALLOWED TO FAIL EITHER. Signed out, unreachable and rate-limited all arrive here
   * as typed failures; none of them is worth refusing to produce a config.
   *
   * ⚠ AND IT IS BOUNDED, WHICH IT WAS NOT — WHICH MADE THE COMMENT BELOW FALSE. A renewal waits up
   * to 15 seconds for the cross-process lock and 20 more on the wire (`jolli/session.ts`,
   * `jolli/exchange.ts`), none of it covered by the catalogue's own deadline, so a student whose
   * token aged out overnight paid all of that before the bounded wait had even started.
   */
  const request = yield* session.request().pipe(
    Effect.timeout(STARTUP_DEADLINE),
    Effect.catchCause(() => Effect.succeed(undefined)),
  )
  const row = yield* session.current()
  if (!row) return jolliBaseConfig({ signedIn: false, models: {} })
  /**
   * ⚠ CONFIG LOADING MUST NOT BE ABLE TO FAIL ON THIS, NOR HOLD A LAUNCH OPEN OVER IT. A defect
   * escaping here stops the server starting, and the thing it would die for is a list of models —
   * so the cause is swallowed and the wait is bounded by `STARTUP_DEADLINE` rather than by the
   * cache's 45-second backstop. The desktop warms this cache by asking the server for the course
   * list before it disposes the instance; the bare CLI does not, so a cold cache behind an
   * unreachable gateway is this path's normal worst case.
   *
   * ⚠ WHAT IS LEFT OF THE DEADLINE, NOT A SECOND HELPING OF IT. The two waits are sequential on one
   * startup path, so giving each the full budget would bound this function at forty seconds while
   * claiming twenty. A refresh that ate the lot leaves nothing here, which `loadCatalog` answers
   * from the stale snapshot or reports as unreachable — the posture it already documents for
   * running out of time.
   */
  const remaining = Duration.millis(
    Math.max(0, Duration.toMillis(STARTUP_DEADLINE) - ((yield* Clock.currentTimeMillis) - started)),
  )
  const loaded = request
    ? yield* loadCatalog(request, { timeout: remaining }).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
    : undefined
  return jolliBaseConfig({
    signedIn: true,
    models: loaded?.kind === "ok" ? yield* declaredModels(loaded.snapshot) : {},
    /**
     * ⚠ THE PIN OUTRANKS THE TENANT, AND `gatewayOptions` IS WHERE THAT IS DECIDED. Both are passed
     * so neither has to be resolved twice; a build that pinned no gateway reaches the same place it
     * always did. See `Flag.JOLLICODE_GATEWAY_URL` for why the bare CLI never sees one.
     */
    ...(Flag.JOLLICODE_GATEWAY_URL ? { gatewayUrl: Flag.JOLLICODE_GATEWAY_URL } : {}),
    ...(row.base_url ? { baseUrl: row.base_url } : {}),
  }) satisfies Info
})

function normalizeLoadedConfig(data: unknown) {
  if (!isRecord(data)) return data
  const copy = { ...data }
  const hadLegacy = "theme" in copy || "keybinds" in copy || "tui" in copy
  if (!hadLegacy) return copy
  delete copy.theme
  delete copy.keybinds
  delete copy.tui
  return copy
}

/**
 * Ask the tenant's Jolliedu backend which MCP servers this session should know
 * about, and hand back a config slice ready to merge.
 *
 * ⚠ SIGNED OUT MEANS NO ROUND-TRIP AT ALL. Nothing to authenticate with, and a
 * signed-out student has no discovery answer to receive either; return an empty
 * slice and let the rest of config load carry on. `jolliLockdownConfig` documents
 * the same posture for its own credential-less branch.
 *
 * ⚠ EVERY FAILURE — signed out, unreachable, timed out, non-2xx, malformed body —
 * COLLAPSES TO A LOADABLE SLICE: the last answer this sign-in received where one may
 * stand in (see below), and an empty slice otherwise. Config load cannot fail on a
 * discovery call: the bare CLI without network access is the normal worst case, and
 * the launch carrying a merged `result` below depends on this returning something loadable.
 *
 * ⚠ ONE DEADLINE FOR THE WHOLE EXCHANGE, NOT ONE PER STEP. Renewal, the request and a
 * retry after a refusal each had their own `STARTUP_DEADLINE`, so an unreachable
 * gateway could hold config load for a minute or more on top of the lockdown fetch it
 * ran after. The layer now runs it beside that fetch, and the network part of it — renewal,
 * request and retry together — shares one `STARTUP_DEADLINE`.
 *
 * ⚠ A RECENT ANSWER IS USED WITHOUT ASKING, AND AN OLDER ONE STANDS IN WHEN ASKING FAILS. Config
 * loads once per instance, so a single failed discovery used to leave the instance without its
 * course tools for as long as it lived, and a slow gateway made every instance wait. The backend's
 * own refusals are not failures to paper over, though: a 4xx or a finished sign-in is its answer,
 * and a 404 — MCP switched off for the tenant — also forgets the old one, so turning the feature
 * off is not undone by the cache.
 *
 * ⚠ THE SLICE CARRIES NO CREDENTIAL. The endpoint deliberately omits the caller's
 * own Authorization value, and this does not add it back: the resolved config is
 * printed by `GET /config` and `debug config`, and a token copied into it would be
 * stale within one token lifetime anyway. The MCP layer attaches the session's
 * current token to each request instead — see `jolliMcpFetch`.
 */
const fetchJolliMcpConfig = (session: JolliSession.Interface, http: HttpClient.HttpClient) =>
  discoverJolliMcpConfig(session, http).pipe(
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        yield* Effect.logWarning("jolli-mcp-config: discovery did not finish", { cause: String(cause) })
        const empty: Info = {}
        return empty
      }),
    ),
  )

const discoverJolliMcpConfig = Effect.fnUntraced(function* (
  session: JolliSession.Interface,
  http: HttpClient.HttpClient,
) {
  const empty: Info = {}
  const started = yield* Clock.currentTimeMillis
  // `session.request()` is the same helper `jolliLockdownConfig` uses to reach the
  // gateway. It splits `credential.base_url` into an origin the REST surface is
  // actually mounted at and a `tenantSlug` that a path-based deployment carries in
  // an `x-tenant-slug` header — see `jolli/api.ts`'s comment on `GatewayRequest`,
  // and `parseJolliUrl`. Concatenating `/api/...` onto the raw `base_url` reaches
  // the app-router SPA, not the API.
  const request = yield* session.request().pipe(
    Effect.timeout(STARTUP_DEADLINE),
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        yield* Effect.logWarning("jolli-mcp-config: session.request() failed", { cause: String(cause) })
        return undefined
      }),
    ),
  )
  if (!request) return empty
  const cached = yield* readMcpConfigCache(request)
  if (cached?.fresh) return yield* jolliMcpSlice(cached.mcp, request.tenantSlug)
  const remaining = Duration.millis(
    Math.max(0, Duration.toMillis(STARTUP_DEADLINE) - ((yield* Clock.currentTimeMillis) - started)),
  )
  // The shared gateway GET, so discovery carries the client's User-Agent and retries a transient
  // failure the way every other gateway read does.
  const outcome = yield* fetchMcpConfig(request).pipe(
    /**
     * ⚠ ONE RENEWAL, AND A RETRY ONLY WITH A DIFFERENT TOKEN. `refused` hands back the token it was
     * given when the renewal endpoint cannot be reached, and resending that is a second 401 paid
     * for out of the startup deadline. The refusal itself is what gets reported then.
     */
    Effect.catchIf(
      (error) => error.status === 401,
      (error) =>
        session
          .refused(request.token)
          .pipe(
            Effect.flatMap((token) =>
              token === request.token ? Effect.fail(error) : fetchMcpConfig({ ...request, token }),
            ),
          ),
    ),
    Effect.provideService(HttpClient.HttpClient, http),
    Effect.map((answer) => ({ ok: true as const, mcp: answer.mcp })),
    Effect.catch((error) => Effect.succeed({ ok: false as const, cause: String(error), answered: answeredBy(error) })),
    Effect.timeout(remaining),
    Effect.catchCause((cause) => Effect.succeed({ ok: false as const, cause: String(cause), answered: undefined })),
  )
  if (outcome.ok) {
    yield* writeMcpConfigCache(request, outcome.mcp)
    return yield* jolliMcpSlice(outcome.mcp, request.tenantSlug)
  }
  // A refusal is the backend's answer, not an outage, so no older answer is put in its place.
  if (outcome.answered !== undefined) {
    if (outcome.answered === 404) yield* dropMcpConfigCache(request)
    yield* Effect.logWarning("jolli-mcp-config: discovery was refused", { cause: outcome.cause })
    return empty
  }
  if (!cached) {
    yield* Effect.logWarning("jolli-mcp-config: discovery request failed", { cause: outcome.cause })
    return empty
  }
  yield* Effect.logWarning("jolli-mcp-config: discovery failed; using the last answer received", {
    cause: outcome.cause,
  })
  return yield* jolliMcpSlice(cached.mcp, request.tenantSlug)
})

/**
 * The status of a refusal the backend actually gave, or undefined for a failure that is no answer at
 * all — the gateway unreachable, a 5xx, or renewal unable to reach it — which an older answer may
 * stand in for. A finished sign-in counts as an answer: its credential would be refused anyway.
 */
function answeredBy(error: { readonly _tag: string; readonly status?: number | undefined }) {
  if (error._tag === "Jolli.SignedOut") return 401
  if (error._tag !== "Jolli.ApiError" || error.status === undefined || error.status >= 500) return undefined
  return error.status
}

/** The config slice for a discovery answer, whether it just arrived or was kept from an earlier one. */
const jolliMcpSlice = Effect.fnUntraced(function* (mcpServers: Readonly<Record<string, unknown>>, tenantSlug?: string) {
  const empty: Info = {}
  // The native MCP endpoint resolves tenancy from the verified JWT; `x-tenant-slug` remains
  // harmless compatibility data for a path-based deployment and is never an authentication input.
  const entry = mcpServers[JOLLI_MCP_SERVER]
  if (!isRecord(entry) || entry.type !== "remote" || typeof entry.url !== "string" || !URL.canParse(entry.url)) {
    yield* Effect.logWarning("jolli-mcp-config: first-party entry missing")
    return empty
  }
  // Only the MCP layer authenticates this server, so an authorization header in the answer, in any case, is dropped.
  const responseHeaders = isRecord(entry.headers)
    ? Object.fromEntries(
        Object.entries(entry.headers).filter(
          (pair): pair is [string, string] => typeof pair[1] === "string" && pair[0].toLowerCase() !== "authorization",
        ),
      )
    : {}
  const mcp: NonNullable<Info["mcp"]> = {
    [JOLLI_MCP_SERVER]: {
      type: "remote",
      url: entry.url,
      oauth: false,
      headers: { ...responseHeaders, ...(tenantSlug ? { "x-tenant-slug": tenantSlug } : {}) },
    },
  }
  yield* Effect.logInfo("jolli-mcp-config: merged", { servers: Object.keys(mcp), tenantSlug: tenantSlug ?? null })
  return { mcp }
})

async function substituteWellKnownRemoteConfig(input: {
  value: unknown
  dir: string
  source: string
  env: Record<string, string>
}) {
  if (!isRecord(input.value) || typeof input.value.url !== "string") return undefined

  const url = await ConfigVariable.substitute({
    text: input.value.url,
    type: "virtual",
    dir: input.dir,
    source: input.source,
    env: input.env,
  })
  const headers = isRecord(input.value.headers)
    ? Object.fromEntries(
        await Promise.all(
          Object.entries(input.value.headers)
            .filter((entry): entry is [string, string] => typeof entry[1] === "string")
            .map(async ([key, value]) => [
              key,
              await ConfigVariable.substitute({
                text: value,
                type: "virtual",
                dir: input.dir,
                source: input.source,
                env: input.env,
              }),
            ]),
        ),
      )
    : undefined

  return { url, headers }
}

async function resolveLoadedPlugins<T extends { plugin?: ConfigPluginV1.Spec[] }>(config: T, filepath: string) {
  if (!config.plugin) return config
  for (let i = 0; i < config.plugin.length; i++) {
    // Normalize path-like plugin specs while we still know which config file declared them.
    // This prevents `./plugin.ts` from being reinterpreted relative to some later merge location.
    config.plugin[i] = await ConfigPlugin.resolvePluginSpec(config.plugin[i], filepath)
  }
  return config
}

type Info = ConfigV1.Info & {
  // plugin_origins is derived state, not a persisted config field. It keeps each winning plugin spec together
  // with the file and scope it came from so later runtime code can make location-sensitive decisions.
  plugin_origins?: ConfigPlugin.Origin[]
}

type State = {
  config: Info
  directories: string[]
  deps: Fiber.Fiber<void>[]
  consoleState: ConsoleState
}

export interface Interface {
  readonly get: () => Effect.Effect<Info>
  readonly getGlobal: () => Effect.Effect<Info>
  readonly getConsoleState: () => Effect.Effect<ConsoleState>
  readonly update: (config: Info) => Effect.Effect<void>
  readonly updateGlobal: (config: Info) => Effect.Effect<{ info: Info; changed: boolean }>
  readonly invalidate: () => Effect.Effect<void>
  readonly directories: () => Effect.Effect<string[]>
  readonly waitForDependencies: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Config") {}

export const use = serviceUse(Service)

function globalConfigFile() {
  const candidates = [`${Brand.bin}.jsonc`, `${Brand.bin}.json`, "config.json"].map((file) =>
    path.join(Global.Path.config, file),
  )
  for (const file of candidates) {
    if (existsSync(file)) return file
  }
  return candidates[0]
}

function patchJsonc(input: string, patch: unknown, path: string[] = []): string {
  if (!isRecord(patch)) {
    const edits = modify(input, path, patch, {
      formattingOptions: {
        insertSpaces: true,
        tabSize: 2,
      },
    })
    return applyEdits(input, edits)
  }

  return Object.entries(patch).reduce((result, [key, value]) => patchJsonc(result, value, [...path, key]), input)
}

function writable(info: Info) {
  const { plugin_origins: _plugin_origins, ...next } = info
  return next
}

function writableGlobal(info: Info) {
  const next = writable(info)
  // When a user changes config from a value back to default in the Desktop app, we don't want to leave a blank `"shell": "",` key
  if ("shell" in next && next.shell === "") return { ...next, shell: undefined }
  return next
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const authSvc = yield* Auth.Service
    const jolliSvc = yield* JolliSession.Service
    const accountSvc = yield* Account.Service
    const env = yield* Env.Service
    const npmSvc = yield* Npm.Service
    const http = yield* HttpClient.HttpClient

    const readConfigFile = (filepath: string) => fs.readFileStringSafe(filepath).pipe(Effect.orDie)

    const decodeConfig = Effect.fnUntraced(function* (input: unknown, source: string) {
      const result = ConfigV2Compat.lower(normalizeLoadedConfig(input), source)
      yield* Effect.forEach(result.diagnostics, (diagnostic) =>
        Effect.logWarning("configuration compatibility diagnostic", {
          source,
          path: diagnostic.path,
          kind: diagnostic.kind,
          action: diagnostic.message,
        }),
      )
      return ConfigParse.schema(ConfigV1.Info, result.value, source)
    })

    const fetchRemoteJson = Effect.fnUntraced(function* <S extends Schema.Top>(
      url: string,
      headers: Record<string, string> | undefined,
      schema: S,
      loginOrigin: string,
    ) {
      const response = yield* HttpClient.filterStatusOk(withTransientReadRetry(http))
        .execute(
          HttpClientRequest.get(url).pipe(HttpClientRequest.acceptJson, HttpClientRequest.setHeaders(headers ?? {})),
        )
        .pipe(
          Effect.catch((error) => Effect.die(new Error(`failed to fetch remote config from ${url}: ${String(error)}`))),
        )
      const body = yield* response.text.pipe(
        Effect.catch((error) => Effect.die(new Error(`failed to read remote config from ${url}: ${String(error)}`))),
      )
      // An auth proxy can answer with an HTML login page at HTTP 200 (passes filterStatusOk); treat it as a re-auth error, not a decode failure.
      const contentType = (response.headers["content-type"] ?? "").toLowerCase()
      if (contentType.includes("html") || /^\s*<!doctype|^\s*<html/i.test(body)) {
        return yield* Effect.die(new RemoteAuthError({ url: loginOrigin, remote: url }))
      }
      return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(body).pipe(
        Effect.catch((error) => Effect.die(new Error(`failed to decode remote config from ${url}: ${String(error)}`))),
      )
    })

    const loadConfig = Effect.fnUntraced(function* (
      text: string,
      options: { path: string } | { dir: string; source: string },
      env?: Record<string, string>,
    ) {
      const source = "path" in options ? options.path : options.source
      const expanded = yield* Effect.promise(() =>
        ConfigVariable.substitute(
          "path" in options
            ? { text, type: "path", path: options.path, env }
            : { text, type: "virtual", ...options, env },
        ),
      )
      const parsed = ConfigParse.jsonc(expanded, source)
      const data = yield* decodeConfig(parsed, source)
      if (!("path" in options)) return data

      yield* Effect.promise(() => resolveLoadedPlugins(data, options.path))
      if (!data.$schema) {
        data.$schema = "https://jolli.ai/config.json"
        const updated = text.replace(/^\s*\{/, '{\n  "$schema": "https://jolli.ai/config.json",')
        yield* fs.writeFileString(options.path, updated).pipe(Effect.catch(() => Effect.void))
      }
      return data
    })

    const loadFile = Effect.fnUntraced(function* (filepath: string, env?: Record<string, string>) {
      yield* Effect.logInfo("loading", { path: filepath })
      const text = yield* readConfigFile(filepath)
      if (!text) return {} as Info
      return yield* loadConfig(text, { path: filepath }, env)
    })

    const loadGlobal = Effect.fnUntraced(function* (env?: Record<string, string>) {
      let result: Info = {}
      // Seed the default global config with the schema for editor completion, but avoid writing when the user
      // explicitly routes config through env-provided paths or content.
      if (!Flag.OPENCODE_CONFIG && !Flag.OPENCODE_CONFIG_DIR && !Flag.OPENCODE_CONFIG_CONTENT) {
        const file = globalConfigFile()
        if (!existsSync(file)) {
          yield* fs
            .writeWithDirs(file, JSON.stringify({ $schema: "https://jolli.ai/config.json" }, null, 2))
            .pipe(Effect.catch(() => Effect.void))
        }
      }
      result = mergeConfig(result, yield* loadFile(path.join(Global.Path.config, "config.json"), env))
      for (const file of ConfigPaths.fileInDirectory(Global.Path.config, Brand.bin)) {
        result = mergeConfig(result, yield* loadFile(file, env))
      }

      const legacy = path.join(Global.Path.config, "config")
      if (existsSync(legacy)) {
        yield* Effect.promise(() =>
          import(pathToFileURL(legacy).href, { with: { type: "toml" } })
            .then(async (mod) => {
              const { provider, model, ...rest } = mod.default
              if (provider && model) result.model = `${provider}/${model}`
              result["$schema"] = "https://jolli.ai/config.json"
              result = mergeConfig(result, rest)
              await fsNode.writeFile(path.join(Global.Path.config, "config.json"), JSON.stringify(result, null, 2))
              await fsNode.unlink(legacy)
            })
            .catch(() => {}),
        )
      }

      return result
    })

    const [cachedGlobal, invalidateGlobal] = yield* Effect.cachedInvalidateWithTTL(
      loadGlobal().pipe(
        Effect.tapError((error) =>
          Effect.logError("failed to load global config, using defaults", { error: String(error) }),
        ),
        Effect.orElseSucceed((): Info => ({})),
      ),
      Duration.infinity,
    )

    const getGlobal = Effect.fn("Config.getGlobal")(function* () {
      return yield* cachedGlobal
    })

    const ensureGitignore = Effect.fn("Config.ensureGitignore")(function* (dir: string) {
      yield* fs.ensureDir(dir)
      const gitignore = path.join(dir, ".gitignore")
      const hasIgnore = yield* fs.existsSafe(gitignore)
      if (!hasIgnore) {
        yield* fs
          .writeFileString(
            gitignore,
            ["node_modules", "package.json", "package-lock.json", "bun.lock", ".gitignore"].join("\n"),
          )
          .pipe(
            Effect.catchIf(
              (e) => e.reason._tag === "PermissionDenied",
              () => Effect.void,
            ),
          )
      }
    })

    const loadInstanceState = Effect.fn("Config.loadInstanceState")(
      function* (ctx: InstanceContext) {
        const auth = yield* authSvc.all().pipe(Effect.orDie)

        /**
         * The shipped Jolli Code product's own floor, seeded as the bottom layer so everything
         * below can still override it. Gated on `JOLLICODE_LOCKDOWN` because this module is a
         * library: applying it unconditionally would make "only Jolli exists" true for every
         * consumer, including the provider tests that legitimately exercise other providers.
         *
         * The provider block only appears once a Jolli credential exists — `jolliBaseConfig`
         * explains why declaring it while signed out breaks first-run sign-in.
         *
         * The course-chat MCP discovery is the product's too, so it is gated the same way, and it
         * runs beside the floor rather than after it: the two bounded waits overlap instead of adding up.
         */
        const unlocked: Info = {}
        const [floor, jolliMcpConfig] = Flag.JOLLICODE_LOCKDOWN
          ? yield* Effect.all([jolliLockdownConfig(jolliSvc), fetchJolliMcpConfig(jolliSvc, http)], {
              concurrency: "unbounded",
            })
          : [unlocked, unlocked]
        let result: Info = floor
        const authEnv: Record<string, string> = {}
        const consoleManagedProviders = new Set<string>()
        let activeOrgName: string | undefined

        const pluginScopeForSource = Effect.fnUntraced(function* (source: string) {
          if (source.startsWith("http://") || source.startsWith("https://")) return "global"
          if (source === "OPENCODE_CONFIG_CONTENT") return "local"
          if (containsPath(source, ctx)) return "local"
          return "global"
        })

        const mergePluginOrigins = Effect.fnUntraced(function* (
          source: string,
          // mergePluginOrigins receives raw Specs from one config source, before provenance for this merge step
          // is attached.
          list: ConfigPluginV1.Spec[] | undefined,
          // Scope can be inferred from the source path, but some callers already know whether the config should
          // behave as global or local and can pass that explicitly.
          kind?: ConfigPlugin.Scope,
        ) {
          if (!list?.length) return
          const hit = kind ?? (yield* pluginScopeForSource(source))
          // Merge newly seen plugin origins with previously collected ones, then dedupe by plugin identity while
          // keeping the winning source/scope metadata for downstream installs, writes, and diagnostics.
          const plugins = ConfigPlugin.deduplicatePluginOrigins([
            ...(result.plugin_origins ?? []),
            ...list.map((spec) => ({ spec, source, scope: hit })),
          ])
          result.plugin = plugins.map((item) => item.spec)
          result.plugin_origins = plugins
        })

        const merge = (source: string, next: Info, kind?: ConfigPlugin.Scope) => {
          result = mergeConfigConcatArrays(result, next)
          return mergePluginOrigins(source, next.plugin, kind)
        }

        for (const [key, value] of Object.entries(auth)) {
          if (value.type === "wellknown") {
            const url = key.replace(/\/+$/, "")
            authEnv[value.key] = value.token
            const wellknownURL = `${url}/.well-known/${Brand.bin}`
            yield* Effect.logDebug("fetching remote config", { url: wellknownURL })
            const wellknown = yield* fetchRemoteJson(wellknownURL, undefined, ConfigV1.WellKnown, url)
            const remote = yield* Effect.promise(() =>
              substituteWellKnownRemoteConfig({
                value: wellknown.remote_config,
                dir: url,
                source: wellknownURL,
                env: authEnv,
              }),
            )
            const fetchedConfig = remote
              ? yield* Effect.gen(function* () {
                  yield* Effect.logDebug("fetching remote config", { url: remote.url })
                  const data = yield* fetchRemoteJson(remote.url, remote.headers, Schema.Json, url)
                  if (isRecord(data) && isRecord(data.config)) return data.config
                  if (isRecord(data)) return data
                  return yield* Effect.die(
                    new Error(`failed to decode remote config from ${remote.url}: expected object`),
                  )
                })
              : {}
            const remoteConfig = mergeConfig(isRecord(wellknown.config) ? wellknown.config : {}, fetchedConfig)
            if (!remoteConfig.$schema) remoteConfig.$schema = "https://jolli.ai/config.json"
            const source = wellknownURL
            const next = yield* loadConfig(
              JSON.stringify(remoteConfig),
              {
                dir: path.dirname(source),
                source,
              },
              authEnv,
            )
            yield* merge(source, next, "global")
            yield* Effect.logDebug("loaded remote config from well-known", { url })
          }
        }

        const global = Object.keys(authEnv).length ? yield* loadGlobal(authEnv) : yield* getGlobal()
        yield* merge(Global.Path.config, global, "global")

        if (Flag.OPENCODE_CONFIG) {
          yield* merge(Flag.OPENCODE_CONFIG, yield* loadFile(Flag.OPENCODE_CONFIG, authEnv))
          yield* Effect.logDebug("loaded custom config", { path: Flag.OPENCODE_CONFIG })
        }

        if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
          for (const file of yield* ConfigPaths.files(Brand.bin, ctx.directory, ctx.worktree).pipe(Effect.orDie)) {
            yield* merge(file, yield* loadFile(file, authEnv), "local")
          }
        }

        result.agent = result.agent || {}
        result.mode = result.mode || {}
        result.plugin = result.plugin || []

        const directories = yield* ConfigPaths.directories(ctx.directory, ctx.worktree)

        if (Flag.OPENCODE_CONFIG_DIR) {
          yield* Effect.logDebug(`loading config from ${envKey("CONFIG_DIR") ?? "JOLLICODE_CONFIG_DIR"}`, {
            path: Flag.OPENCODE_CONFIG_DIR,
          })
        }

        const deps: Fiber.Fiber<void>[] = []

        for (const dir of directories) {
          if (dir.endsWith(".jollicode") || dir === Flag.OPENCODE_CONFIG_DIR) {
            for (const source of ConfigPaths.fileInDirectory(dir, Brand.bin)) {
              yield* Effect.logDebug(`loading config from ${source}`)
              yield* merge(source, yield* loadFile(source, authEnv))
              result.agent ??= {}
              result.mode ??= {}
              result.plugin ??= []
            }
          }

          yield* ensureGitignore(dir).pipe(Effect.orDie)

          const dep = yield* npmSvc
            .install(dir, {
              add: [
                {
                  name: "@opencode-ai/plugin",
                  version: InstallationLocal ? undefined : InstallationVersion,
                },
              ],
            })
            .pipe(
              Effect.exit,
              Effect.tap((exit) =>
                Exit.isFailure(exit)
                  ? Effect.logWarning("background dependency install failed", { dir, error: String(exit.cause) })
                  : Effect.void,
              ),
              Effect.asVoid,
              Effect.forkDetach,
            )
          deps.push(dep)

          result.command = mergeDeep(result.command ?? {}, yield* Effect.promise(() => ConfigCommand.load(dir)))
          result.agent = mergeDeep(result.agent ?? {}, yield* Effect.promise(() => ConfigAgent.load(dir)))
          result.agent = mergeDeep(result.agent ?? {}, yield* Effect.promise(() => ConfigAgent.loadMode(dir)))
          // Auto-discovered plugins under `.jollicode/plugin(s)` are already local files, so ConfigPlugin.load
          // returns normalized Specs and we only need to attach origin metadata here.
          const list = yield* Effect.promise(() => ConfigPlugin.load(dir))
          yield* mergePluginOrigins(dir, list)
        }

        const configContent = Flag.OPENCODE_CONFIG_CONTENT
        if (configContent) {
          // Provenance label is an internal identifier (see pluginScopeForSource
          // and the layer map below), not the env var the user set; it stays
          // stable while Flag resolves the canonical JOLLICODE_ prefix.
          const source = "OPENCODE_CONFIG_CONTENT"
          const next = yield* loadConfig(configContent, {
            dir: ctx.directory,
            source,
          })
          yield* merge(source, next, "local")
          yield* Effect.logDebug(`loaded custom config from ${envKey("CONFIG_CONTENT") ?? "JOLLICODE_CONFIG_CONTENT"}`)
        }

        const activeAccount = Option.getOrUndefined(
          yield* accountSvc.active().pipe(Effect.catch(() => Effect.succeed(Option.none()))),
        )
        if (activeAccount?.active_org_id) {
          const accountID = activeAccount.id
          const orgID = activeAccount.active_org_id
          const url = activeAccount.url
          yield* Effect.gen(function* () {
            const [configOpt, tokenOpt] = yield* Effect.all(
              [accountSvc.config(accountID, orgID), accountSvc.token(accountID)],
              { concurrency: 2 },
            )
            if (Option.isSome(tokenOpt)) {
              process.env["OPENCODE_CONSOLE_TOKEN"] = tokenOpt.value
              yield* env.set("OPENCODE_CONSOLE_TOKEN", tokenOpt.value)
            }

            if (Option.isSome(configOpt)) {
              const source = `${url}/api/config`
              const next = yield* loadConfig(JSON.stringify(configOpt.value), {
                dir: path.dirname(source),
                source,
              })
              for (const providerID of Object.keys(next.provider ?? {})) {
                consoleManagedProviders.add(providerID)
              }
              yield* merge(source, next, "global")
            }
          }).pipe(
            Effect.withSpan("Config.loadActiveOrgConfig"),
            Effect.catch((err) =>
              Effect.logDebug("failed to fetch remote account config", {
                error: err instanceof Error ? err.message : String(err),
              }),
            ),
          )
        }

        const managedDir = ConfigManaged.managedConfigDir()
        if (existsSync(managedDir)) {
          for (const source of ConfigPaths.fileInDirectory(managedDir, Brand.bin)) {
            yield* merge(source, yield* loadFile(source), "global")
          }
        }

        // macOS managed preferences (.mobileconfig deployed via MDM) override everything
        const managed = yield* Effect.promise(() => ConfigManaged.readManagedPreferences())
        if (managed) {
          result = mergeConfigConcatArrays(
            result,
            yield* loadConfig(managed.text, {
              dir: path.dirname(managed.source),
              source: managed.source,
            }),
          )
        }

        for (const [name, mode] of Object.entries(result.mode ?? {})) {
          result.agent = mergeDeep(result.agent ?? {}, {
            [name]: {
              ...mode,
              mode: "primary" as const,
            },
          })
        }

        if (Flag.OPENCODE_PERMISSION) {
          try {
            result.permission = mergeDeep(result.permission ?? {}, JSON.parse(Flag.OPENCODE_PERMISSION))
          } catch (err) {
            yield* Effect.logWarning(
              `${envKey("PERMISSION") ?? "JOLLICODE_PERMISSION"} contains invalid JSON, skipping`,
              { err },
            )
          }
        }

        if (result.tools) {
          const perms: Record<string, ConfigPermissionV1.Action> = {}
          for (const [tool, enabled] of Object.entries(result.tools)) {
            const action: ConfigPermissionV1.Action = enabled ? "allow" : "deny"
            if (tool === "write" || tool === "edit" || tool === "patch") {
              perms.edit = action
              continue
            }
            perms[tool] = action
          }
          result.permission = mergeDeep(perms, result.permission ?? {})
        }

        if (!result.username) {
          try {
            result.username = os.userInfo().username || "user"
          } catch (err) {
            yield* Effect.logWarning("failed to read system username, using fallback", { err })
            result.username = "user"
          }
        }

        if (result.autoshare === true && !result.share) {
          result.share = "auto"
        }

        if (Flag.OPENCODE_DISABLE_AUTOCOMPACT) {
          result.compaction = { ...result.compaction, auto: false }
        }
        if (Flag.OPENCODE_DISABLE_PRUNE) {
          result.compaction = { ...result.compaction, prune: false }
        }

        /**
         * THE CEILING, APPLIED AFTER EVERY LAYER HAS MERGED — WHICH IS THE ONLY PLACE IT CAN BE.
         *
         * ⚠ LAYERING CANNOT DO THIS JOB, AND THAT IS NOT AN OPINION. `mergeConfigConcatArrays` is
         * remeda's `mergeDeep`: a key one layer sets survives every layer above it, because no
         * layer can express "remove this". So the two holes below are unreachable from any config
         * layer and have to be closed here, once, at the end.
         *
         * ⚠ GATED ON THE STRICT FLAG, NOT ON `JOLLICODE_LOCKDOWN`. The bare CLI keeps a floor a
         * coursework repo may step over — pinned by `test/config/jolli-lockdown.test.ts`. Only the
         * desktop sidecar sets this one, and only that surface is genuinely locked.
         */
        if (Flag.JOLLICODE_LOCKDOWN_STRICT) {
          const providers = result.provider
          if (providers) {
            const credential = yield* jolliSvc.current()
            /**
             * ⚠ THE BARE `jolli` ID IS THE AUTH SURFACE, NOT A PROVIDER ANYTHING RUNS AGAINST, so a
             * block under it can only have come from a config layer. `enabled_providers` names the
             * protocol ids alone, and `jolliBaseConfig` never emits this key — leaving it in
             * place hands a coursework repo a provider whose `npm`, `baseURL` and models nothing
             * below pins.
             */
            delete providers[Brand.short]
            /**
             * ⚠ THE TENANT'S OWN ENDPOINT WINS, AND THE CREDENTIAL NEVER COMES FROM CONFIG. A repo
             * that sets `options.apiKey` would otherwise run this locked surface as whichever
             * account it named; one that sets `baseURL` would send the student's token to an
             * address of its choosing. The provider's own `fetch` re-checks the origin too — this
             * is the config half of the same rule.
             *
             * ⚠ SIGNED OUT MEANS NO PROVIDER BLOCK AT ALL, WHOEVER DECLARED IT. `connected` counts
             * every provider that resolved, so a coursework repo declaring one with models would
             * make the app believe the student is already signed in — and the first-run sign-in
             * would never trigger. `gateway-config.ts` spells out that failure.
             *
             * ⚠ THE BUILD'S PIN IS PART OF WHAT IS BEING PINNED BACK, AND OMITTING IT SILENTLY
             * DISARMED IT. What is rebuilt here is written over whatever merged, so a field left
             * out is not "unchanged" — it is REPLACED by the default. `JOLLICODE_CONFIG_CONTENT`
             * carries a build-pinned gateway down from the desktop; rebuilt without it, every model
             * call left a demo or fixture build for the tenant's address or `Brand.gatewayUrl`,
             * with the student's credential on it. The desktop is also the only surface that sets
             * the strict flag, so the two were always on together and the pin never survived.
             */
            const pinned = credential
              ? jolliBaseConfig({
                  signedIn: true,
                  ...(Flag.JOLLICODE_GATEWAY_URL ? { gatewayUrl: Flag.JOLLICODE_GATEWAY_URL } : {}),
                  ...(credential.base_url ? { baseUrl: credential.base_url } : {}),
                }).provider
              : undefined
            for (const id of JOLLI_PROVIDER_IDS) {
              const block = providers[id]
              if (!block) continue
              if (!pinned) {
                delete providers[id]
                continue
              }
              block.options = { ...block.options, ...pinned[id]?.options }
              delete block.options["apiKey"]
              if (pinned[id]?.npm) block.npm = pinned[id].npm
              /**
               * ⚠ THE NAME IS PINNED TO THE FLOOR'S, NOT TO THE CEILING'S, BECAUSE THE CEILING HAS
               * NONE. The picker groups under it, so it tells the student whose model they are on,
               * and a repo that renamed `jolli-openai` to `Anthropic` would say otherwise. Only the
               * floor holds the catalogue the name is derived from; the ceiling omits it for exactly
               * that reason, which is also why the rebuilt `pinned` cannot supply it.
               */
              block.name = floor.provider?.[id]?.name
            }
          }
        }

        /**
         * THE DISCOVERED MCP ENTRY WINS AS A WHOLE ENTRY.
         *
         * Applying it before local config would let a coursework repository replace only the
         * URL, or disable the server, while keeping the rest of the backend's answer. A shallow
         * entry-level replacement here preserves unrelated local MCP servers while keeping each
         * backend-managed entry exactly as the backend answered it. The student's credential is
         * not in the entry at all; the MCP layer attaches it per request, and only on a Jolli origin.
         */
        if (jolliMcpConfig.mcp) {
          result.mcp = { ...result.mcp, ...jolliMcpConfig.mcp }
        }

        return {
          config: result,
          directories,
          deps,
          consoleState: {
            consoleManagedProviders: Array.from(consoleManagedProviders),
            activeOrgName,
            switchableOrgCount: 0,
          },
        }
      },
      Effect.provideService(FSUtil.Service, fs),
    )

    const state = yield* InstanceState.make<State>(
      Effect.fn("Config.state")(function* (ctx) {
        return yield* loadInstanceState(ctx).pipe(Effect.orDie)
      }),
    )

    const get = Effect.fn("Config.get")(function* () {
      return yield* InstanceState.use(state, (s) => s.config)
    })

    const directories = Effect.fn("Config.directories")(function* () {
      return yield* InstanceState.use(state, (s) => s.directories)
    })

    const getConsoleState = Effect.fn("Config.getConsoleState")(function* () {
      return yield* InstanceState.use(state, (s) => s.consoleState)
    })

    const waitForDependencies = Effect.fn("Config.waitForDependencies")(function* () {
      yield* InstanceState.useEffect(state, (s) =>
        Effect.forEach(s.deps, Fiber.join, { concurrency: "unbounded" }).pipe(Effect.asVoid),
      )
    })

    const update = Effect.fn("Config.update")(function* (config: Info) {
      const dir = yield* InstanceState.directory
      const file = path.join(dir, "config.json")
      const existing = yield* loadFile(file)
      const text = yield* readConfigFile(file)
      const original = text ? ConfigParse.jsonc(text, file) : writable(existing)
      yield* fs
        .writeFileString(
          file,
          JSON.stringify(mergeDeep(isRecord(original) ? original : writable(existing), writable(config)), null, 2),
        )
        .pipe(Effect.orDie)
    })

    const invalidate = Effect.fn("Config.invalidate")(function* () {
      yield* invalidateGlobal
    })

    const updateGlobal = Effect.fn("Config.updateGlobal")(function* (config: Info) {
      const file = globalConfigFile()
      const before = (yield* readConfigFile(file)) ?? "{}"
      const patch = writableGlobal(config)

      let next: Info
      let changed: boolean
      if (!file.endsWith(".jsonc")) {
        const existing = ConfigParse.jsonc(before, file)
        ConfigParse.schema(ConfigV1.Info, ConfigV2Compat.lower(normalizeLoadedConfig(existing), file).value, file)
        const merged = mergeDeep(isRecord(existing) ? existing : {}, patch)
        const serialized = JSON.stringify(merged, null, 2)
        next = yield* decodeConfig(merged, file)
        changed = serialized !== before
        if (changed) yield* fs.writeFileString(file, serialized).pipe(Effect.orDie)
      } else {
        const updated = patchJsonc(before, patch)
        next = yield* decodeConfig(ConfigParse.jsonc(updated, file), file)
        changed = updated !== before
        if (changed) yield* fs.writeFileString(file, updated).pipe(Effect.orDie)
      }

      if (changed) yield* invalidate()
      return { info: next, changed }
    })

    return Service.of({
      get,
      getGlobal,
      getConsoleState,
      update,
      updateGlobal,
      invalidate,
      directories,
      waitForDependencies,
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [FSUtil.node, Auth.node, Account.node, Env.node, Npm.node, JolliSession.node, httpClient],
})

export * as Config from "./config"
