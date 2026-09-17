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
