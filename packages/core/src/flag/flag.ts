import { Config } from "effect"

export function truthy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "true" || value === "1"
}

const CANONICAL_PREFIX = "JOLLICODE_"
const LEGACY_PREFIX = "OPENCODE_"

/**
 * Resolve an env var by suffix, preferring the canonical JOLLICODE_ prefix and
 * falling back to the deprecated OPENCODE_ prefix.
 * `suffix` excludes the prefix, e.g. env("CONFIG") => JOLLICODE_CONFIG ?? OPENCODE_CONFIG.
 * OPENCODE_ fallback is silent for now; reintroduce a logger-based deprecation surface before external release (see env-sweep follow-on).
 */
export function env(suffix: string): string | undefined {
  const canonical = process.env[CANONICAL_PREFIX + suffix]
  if (canonical !== undefined) return canonical
  return process.env[LEGACY_PREFIX + suffix]
}

/**
 * Which env var actually supplied `suffix` — the canonical key when set, else the legacy alias,
 * else undefined. Lets callers report the real source (and is the seam for the deprecation warning
 * promised above: a value coming back on the LEGACY_PREFIX is a legacy read).
 */
export function envKey(suffix: string): string | undefined {
  if (process.env[CANONICAL_PREFIX + suffix] !== undefined) return CANONICAL_PREFIX + suffix
  if (process.env[LEGACY_PREFIX + suffix] !== undefined) return LEGACY_PREFIX + suffix
  return undefined
}

export function truthyEnv(suffix: string): boolean {
  const value = env(suffix)?.toLowerCase()
  return value === "true" || value === "1"
}

const copy = env("EXPERIMENTAL_DISABLE_COPY_ON_SELECT")
const fff = env("DISABLE_FFF")

function enabledByExperimental(suffix: string) {
  return env(suffix) === undefined ? truthyEnv("EXPERIMENTAL") : truthyEnv(suffix)
}

export const Flag = {
  OTEL_EXPORTER_OTLP_ENDPOINT: process.env["OTEL_EXPORTER_OTLP_ENDPOINT"],
  OTEL_EXPORTER_OTLP_HEADERS: process.env["OTEL_EXPORTER_OTLP_HEADERS"],

  OPENCODE_AUTO_HEAP_SNAPSHOT: truthyEnv("AUTO_HEAP_SNAPSHOT"),
  OPENCODE_GIT_BASH_PATH: env("GIT_BASH_PATH"),
  OPENCODE_CONFIG: env("CONFIG"),
  // Evaluated at access time (not module load) because tests, the CLI, the
  // desktop gateway, and the SDK all set JOLLICODE_/OPENCODE_CONFIG_CONTENT at
  // runtime before config loads and expect it to be observed.
  get OPENCODE_CONFIG_CONTENT() {
    return env("CONFIG_CONTENT")
  },
  // Evaluated at access time (not module load) because the new test plan for
  // this flag sets JOLLICODE_DISABLE_AUTOUPDATE at runtime and expects it to
  // be observed immediately.
  get OPENCODE_DISABLE_AUTOUPDATE() {
    return truthyEnv("DISABLE_AUTOUPDATE")
  },
  /**
   * Whether this process is the shipped Jolli Code product rather than a bare library consumer.
   *
   * ⚠ THE LOCKDOWN IS THE PRODUCT'S, NOT THE LIBRARY'S, WHICH IS THE WHOLE REASON THIS FLAG EXISTS.
   * `enabled_providers: ["jolli"]` applied unconditionally inside the config loader makes "only
   * Jolli exists" true for every consumer of that module, which is wrong for a library and breaks
   * the upstream provider tests that legitimately exercise other providers. The `jollicode` entry
   * point sets this; nothing else does.
   *
   * Evaluated at access time because the entry point sets it at runtime, before config loads.
   */
  get JOLLICODE_LOCKDOWN() {
    return truthyEnv("LOCKDOWN")
  },
  /**
   * THE CEILING, AS OPPOSED TO THE FLOOR.
   *
   * ⚠ A SEPARATE FLAG FROM `JOLLICODE_LOCKDOWN`, DELIBERATELY. That one seeds the Jolli floor as the
   * BOTTOM config layer, which a coursework repo is allowed to step over — behaviour
   * `test/config/jolli-lockdown.test.ts` pins on purpose. This one runs AFTER every layer has
   * merged and takes things back: no config-supplied `apiKey`, the tenant's own `baseURL`, and no
   * Jolli provider at all while signed out. Folding the two together would flip those tests, and
   * those tests failing is the alarm, not a chore.
   *
   * ⚠ ONLY `createSidecarEnv()` SETS IT. The desktop is the surface that is genuinely locked; the
   * bare CLI keeps its steppable floor.
   */
  get JOLLICODE_LOCKDOWN_STRICT() {
    return truthyEnv("LOCKDOWN_STRICT")
  },
  /**
   * THE GATEWAY THIS BUILD IS PINNED TO, WHEN THE SURFACE IS ONE THAT MAY BE PINNED AT ALL.
   *
   * ⚠ IT IS A BUILD-TIME VALUE THAT TRAVELS AS AN ENV VAR, WHICH IS WHY IT READS AS A CONTRADICTION
   * OF `jolli-gateway.ts`. The desktop bakes `JOLLICODE_GATEWAY_URL` into its bundle at build time
   * precisely so a student cannot repoint the gateway from `~/.zshrc` — but the server that has to
   * honour it is a different process, and `createSidecarEnv()` is the channel the desktop already
   * uses to hand that process values a student must not be able to forge. It scrubs this key out of
   * the inherited environment and writes its own, exactly as it does for `JOLLICODE_CONFIG_CONTENT`.
   *
   * ⚠ HENCE THE STRICT GATE, AND IT IS LOAD-BEARING RATHER THAN TIDY. On the bare CLI this is just
   * an env var, and a pinned gateway is not merely a URL: `gateway-config.ts` exempts it from the
   * origin allowlist and `plugin/jolli.ts` therefore attaches the student's credential to it. Read
   * unconditionally, a single exported variable would be somewhere to send that credential. Strict
   * lockdown is set by `createSidecarEnv()` and nothing else, so this answers `undefined` everywhere
   * the value would not have come from a build.
   */
  get JOLLICODE_GATEWAY_URL() {
    if (!truthyEnv("LOCKDOWN_STRICT")) return undefined
    return env("GATEWAY_URL")?.trim() || undefined
  },
  OPENCODE_ALWAYS_NOTIFY_UPDATE: truthyEnv("ALWAYS_NOTIFY_UPDATE"),
  OPENCODE_DISABLE_PRUNE: truthyEnv("DISABLE_PRUNE"),
  OPENCODE_DISABLE_TERMINAL_TITLE: truthyEnv("DISABLE_TERMINAL_TITLE"),
  OPENCODE_SHOW_TTFD: truthyEnv("SHOW_TTFD"),
  OPENCODE_DISABLE_AUTOCOMPACT: truthyEnv("DISABLE_AUTOCOMPACT"),
  OPENCODE_DISABLE_MODELS_FETCH: truthyEnv("DISABLE_MODELS_FETCH"),
  OPENCODE_DISABLE_MOUSE: truthyEnv("DISABLE_MOUSE"),
  OPENCODE_FAKE_VCS: env("FAKE_VCS"),
  OPENCODE_SERVER_PASSWORD: env("SERVER_PASSWORD"),
  OPENCODE_SERVER_USERNAME: env("SERVER_USERNAME"),
  OPENCODE_DISABLE_FFF: fff === undefined ? process.platform === "win32" : truthyEnv("DISABLE_FFF"),

  // Experimental
  OPENCODE_EXPERIMENTAL_FILEWATCHER: Config.boolean("JOLLICODE_EXPERIMENTAL_FILEWATCHER").pipe(
    Config.orElse(() => Config.boolean("OPENCODE_EXPERIMENTAL_FILEWATCHER")),
    Config.withDefault(false),
  ),
  OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: Config.boolean("JOLLICODE_EXPERIMENTAL_DISABLE_FILEWATCHER").pipe(
    Config.orElse(() => Config.boolean("OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER")),
    Config.withDefault(false),
  ),
  OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT:
    copy === undefined ? process.platform === "win32" : truthyEnv("EXPERIMENTAL_DISABLE_COPY_ON_SELECT"),
  OPENCODE_MODELS_URL: env("MODELS_URL"),
  OPENCODE_MODELS_PATH: env("MODELS_PATH"),
  OPENCODE_DB: env("DB"),

  OPENCODE_WORKSPACE_ID: env("WORKSPACE_ID"),
  OPENCODE_EXPERIMENTAL_WORKSPACES: enabledByExperimental("EXPERIMENTAL_WORKSPACES"),

  // Evaluated at access time (not module load) because tests, the CLI, and
  // external tooling set these env vars at runtime.
  get OPENCODE_DISABLE_PROJECT_CONFIG() {
    return truthyEnv("DISABLE_PROJECT_CONFIG")
  },
  get OPENCODE_EXPERIMENTAL_REFERENCES() {
    return enabledByExperimental("EXPERIMENTAL_REFERENCES")
  },
  get OPENCODE_TUI_CONFIG() {
    return env("TUI_CONFIG")
  },
  get OPENCODE_CONFIG_DIR() {
    return env("CONFIG_DIR")
  },
  get OPENCODE_PURE() {
    return truthyEnv("PURE")
  },
  get OPENCODE_PERMISSION() {
    return env("PERMISSION")
  },
  get OPENCODE_PLUGIN_META_FILE() {
    return env("PLUGIN_META_FILE")
  },
  get OPENCODE_CLIENT() {
    return env("CLIENT") ?? "cli"
  },
}
