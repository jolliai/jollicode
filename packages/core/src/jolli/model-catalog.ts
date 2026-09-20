/**
 * THE MODELS THE JOLLI GATEWAY DECLARES, AND THEIR TIERS — THE ONE PLACE THE LIST LIVES.
 *
 * ⚠ SEVERAL SURFACES READ THIS, SO IT IS DEFINED ONCE. `gateway-config.ts` next door serves the
 * catalogue as the provider config for both the bare CLI/TUI and the desktop sidecar, and the
 * renderer's coaching heuristic (`packages/app/src/jolli/coaching.ts`) reads each model's `tier` to
 * decide the model-choice nudge. All of them consume this array so they can never disagree about
 * which model is premium and which is economy — an earlier build kept the tiers as a second copy
 * (regexes in `coaching.ts`) and they drifted from the catalogue twice: `flash` matched five
 * standard models and four premium `*-pro` models matched nothing.
 *
 * ⚠ IT LIVES IN CORE, NOT IN THE RENDERER PACKAGE. The config that declares these models is built
 * for the CLI too, and `packages/opencode` cannot import `packages/app`. `packages/app` re-exports
 * it so renderer imports keep working.
 *
 * ⚠ IDS AND LABELS ARE THE WEB MOCK'S, ROW FOR ROW (jolli-edu-design, `app/src/data/models.ts`). The
 * gateway routes each tier to a model that actually answers; that routing lives with the gateway.
 */
export type ModelTier = "premium" | "standard" | "economy"

export const MODEL_CATALOG: Array<{ id: string; label: string; tier: ModelTier }> = [
  { id: "claude-opus-5", label: "Claude Opus 5", tier: "premium" },
  { id: "claude-opus-4-8", label: "Claude Opus 4.8", tier: "premium" },
  { id: "claude-opus-4-7", label: "Claude Opus 4.7", tier: "premium" },
  { id: "claude-opus-4-6", label: "Claude Opus 4.6", tier: "premium" },
  { id: "claude-opus-4-5", label: "Claude Opus 4.5", tier: "premium" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5", tier: "standard" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", tier: "standard" },
  { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", tier: "standard" },
  { id: "claude-sonnet-4", label: "Claude Sonnet 4", tier: "standard" },
  { id: "claude-sonnet-3-7", label: "Claude Sonnet 3.7", tier: "standard" },
  { id: "gpt-5-6-sol", label: "GPT-5.6 Sol", tier: "premium" },
  { id: "gpt-5-6-terra", label: "GPT-5.6 Terra", tier: "premium" },
  { id: "gpt-5.5", label: "GPT-5.5", tier: "standard" },
  { id: "gpt-5.4", label: "GPT-5.4", tier: "standard" },
  { id: "gpt-5.3", label: "GPT-5.3", tier: "standard" },
  { id: "gpt-5.2", label: "GPT-5.2", tier: "standard" },
  { id: "gpt-5.1", label: "GPT-5.1", tier: "standard" },
  { id: "gemini-3-1-pro", label: "Gemini 3.1 Pro", tier: "premium" },
  { id: "gemini-3-pro", label: "Gemini 3 Pro", tier: "premium" },
  { id: "gemini-2-5-pro", label: "Gemini 2.5 Pro", tier: "premium" },
  { id: "gemini-2-0-pro", label: "Gemini 2.0 Pro", tier: "premium" },
  { id: "gemini-1-5-pro", label: "Gemini 1.5 Pro", tier: "premium" },
  { id: "gemini-3-7-flash", label: "Gemini 3.7 Flash", tier: "standard" },
  { id: "gemini-3-6-flash", label: "Gemini 3.6 Flash", tier: "standard" },
  { id: "gemini-3-5-flash", label: "Gemini 3.5 Flash", tier: "standard" },
  { id: "gemini-3-flash", label: "Gemini 3 Flash", tier: "standard" },
  { id: "gemini-2-5-flash", label: "Gemini 2.5 Flash", tier: "standard" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", tier: "economy" },
  { id: "claude-haiku-3-5", label: "Claude Haiku 3.5", tier: "economy" },
  { id: "claude-haiku-3", label: "Claude Haiku 3", tier: "economy" },
  { id: "gpt-5-6-luna", label: "GPT-5.6 Luna", tier: "economy" },
  { id: "gemini-3-1-flash-lite", label: "Gemini 3.1 Flash-Lite", tier: "economy" },
  { id: "gemini-2-5-flash-lite", label: "Gemini 2.5 Flash-Lite", tier: "economy" },
  { id: "gemini-2-0-flash-lite", label: "Gemini 2.0 Flash-Lite", tier: "economy" },
]

/**
 * The tier of a model, or undefined when the catalogue does not list it (so callers can stay silent
 * on a model nobody classified). Accepts an opencode model key (`providerID/modelID`) or a bare id.
 */
export function modelTier(modelKey: string): ModelTier | undefined {
  const id = modelKey.slice(modelKey.lastIndexOf("/") + 1)
  return MODEL_CATALOG.find((model) => model.id === id)?.tier
}

/**
 * The catalogue in the shape `jolliBaseConfig` takes.
 *
 * ⚠ THIS FUNCTION IS THE SEAM, AND IT IS MEANT TO BE DELETED. Which models a student may run is the
 * server's answer — Jolli records it per course assistant (`allowedModelIds`, plus a resolved
 * catalogue) — and the config builder already takes the list as a parameter for that reason. Until
 * sign-in fetches the grant, both callers get it from here. When it does, they stop calling this and
 * nothing in `gateway-config.ts` moves.
 *
 * `route` maps each tier onto a model that actually answers; it is the desktop mock's pretence and
 * omitting it sends the catalogue id upstream unchanged.
 */
export function catalogModels(route?: Record<ModelTier, string>) {
  return MODEL_CATALOG.map(({ id, label, tier }) => ({
    id,
    name: label,
    ...(route ? { upstreamId: route[tier] } : {}),
  }))
}
