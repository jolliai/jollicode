import { batch, createMemo, startTransition } from "solid-js"
import { useModels } from "@/context/models"
import type { ModelKey, ModelSelection } from "@/context/local"
import { cycleModelVariant, getConfiguredAgentVariant, resolveModelVariant } from "@/context/model-variant"
import { usePrompt } from "@/context/prompt"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useProviders } from "@/hooks/use-providers"
import { resolveDefaultModel } from "@/hooks/provider-catalog"
import { isModelAllowed, ModelGrant, parseModelKey } from "@/jolli/model-grant"

/**
 * ⚠ THIS IS THE SECOND IMPLEMENTATION OF THE SELECTION CHAIN IN `context/local.tsx`, AND THE
 * NEW-SESSION COMPOSER USES THIS ONE. Upstream keeps the two in parallel (`new-session-draft-controller.ts`
 * builds this; a live session reads `local.model`), which means every rule about what a course
 * allows has to be written twice or it applies on one screen and not the other — and the screen it
 * would have missed is the one where a student picks their course.
 */

export function createPromptModelSelection(input: { agent: () => { model?: ModelKey; variant?: string } | undefined }) {
  const sdk = useSDK()
  const sync = useSync()
  const models = useModels()
  const prompt = usePrompt()
  const providers = useProviders(() => sdk().directory)
  const connected = createMemo(() => new Set(providers.connected().map((item) => item.id)))
  /**
   * ⚠ VALIDITY INCLUDES THE COURSE GRANT, exactly as in `context/local.tsx`. Without it a model the
   * assistant does not allow can still be resolved from a saved preference; the picker would not
   * offer it, and the composer would run on it anyway.
   */
  const valid = (model: ModelKey) => {
    const provider = providers.all().get(model.providerID)
    if (!provider?.models[model.modelID] || !connected().has(model.providerID)) return false
    return isModelAllowed(model.providerID, model.modelID)
  }

  /** The model the professor set on this assistant. See `Assistant.modelId`. */
  const preferred = () => parseModelKey(ModelGrant.preferred())

  const configured = () => {
    const model = resolveDefaultModel(providers.defaultModel(), sync().data.config.model)
    if (!model) return
    if (valid(model)) return model
  }

  const recent = () => models.recent.list().find(valid)
  /**
   * ⚠ EVERY MODEL OF THE PROVIDER, WHERE UPSTREAM TOOK ONLY THE FIRST. Under a course grant the
   * provider's first model is usually not allowed, and stopping there left the composer with no
   * model at all.
   */
  const fallback = () => {
    const defaults = providers.default()
    return providers.connected().flatMap((provider) => {
      const configuredID = defaults[provider.id]
      const ids = configuredID ? [configuredID, ...Object.keys(provider.models)] : Object.keys(provider.models)
      return ids.map((modelID) => ({ providerID: provider.id, modelID })).filter(valid)
    })[0]
  }

  const current = () => {
    /**
     * ⚠ THE PROFESSOR'S MODEL COMES BEFORE THE RECENT LIST AND THE PROVIDER DEFAULT, and after the
     * student's own pick for this session. A course that pinned Opus 4.8 starts every session there.
     */
    const key = [
      prompt.model.current(),
      input.agent()?.model,
      preferred(),
      // A course that granted exactly one model selects it. `ModelGrant.only` says why it outranks
      // the rest of this chain, and `valid()` below is what still refuses one this install cannot run.
      ModelGrant.only(),
      configured(),
      recent(),
      fallback(),
    ].find((item): item is ModelKey => !!item && valid(item))
    if (!key) return
    return models.find(key)
  }
  const recentModels = createMemo(() =>
    models.recent
      .list()
      .map(models.find)
      .filter((item): item is NonNullable<typeof item> => !!item),
  )

  const selection = {
    ready: models.ready,
    current,
    recent: recentModels,
    list: models.list,
    cycle(direction: 1 | -1) {
      const items = recentModels()
      const item = current()
      if (!item) return
      const index = items.findIndex((entry) => entry.provider.id === item.provider.id && entry.id === item.id)
      if (index === -1) return
      const next = items[(index + direction + items.length) % items.length]
      if (next) selection.set({ providerID: next.provider.id, modelID: next.id })
    },
    set(item: ModelKey | undefined, options?: { recent?: boolean }) {
      startTransition(() =>
        batch(() => {
          prompt.model.set(item ? { ...item, variant: prompt.model.current()?.variant } : undefined)
          if (!item) return
          models.setVisibility(item, true)
          if (options?.recent) models.recent.push(item)
        }),
      )
    },
    visible: models.visible,
    setVisibility: models.setVisibility,
    variant: {
      configured() {
        const item = input.agent()
        const model = current()
        if (!item || !model) return
        return getConfiguredAgentVariant({
          agent: { model: item.model, variant: item.variant },
          model: { providerID: model.provider.id, modelID: model.id, variants: model.variants },
        })
      },
      selected() {
        return prompt.model.current()?.variant
      },
      current() {
        const resolved = resolveModelVariant({
          variants: this.list(),
          selected: this.selected(),
          configured: this.configured(),
        })
        if (resolved) return resolved
        const model = current()
        if (!model) return
        const saved = models.variant.get({ providerID: model.provider.id, modelID: model.id })
        if (saved && this.list().includes(saved)) return saved
      },
      list() {
        return Object.keys(current()?.variants ?? {})
      },
      set(value: string | undefined) {
        startTransition(() =>
          batch(() => {
            const model = current()
            if (!model) return
            prompt.model.set({ providerID: model.provider.id, modelID: model.id, variant: value ?? null })
            models.variant.set({ providerID: model.provider.id, modelID: model.id }, value)
          }),
        )
      },
      cycle() {
        const variants = this.list()
        if (variants.length === 0) return
        this.set(
          cycleModelVariant({
            variants,
            selected: this.selected(),
            configured: this.configured(),
          }),
        )
      },
    },
  } satisfies ModelSelection

  return selection
}
