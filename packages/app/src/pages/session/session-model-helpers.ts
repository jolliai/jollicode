import type { UserMessage } from "@opencode-ai/sdk/v2"

type Local = {
  session: {
    reset(): void
    restore(msg: UserMessage): void
  }
}

type ModelSelection = {
  model: {
    current(): { id: string; provider: { id: string } } | undefined
    set(model: { providerID: string; modelID: string }): void
    variant: {
      current(): string | undefined
      set(variant: string | undefined): void
    }
  }
}

type PromptState = {
  model: {
    current(): { providerID: string; modelID: string; variant?: string | null } | undefined
    set(model: { providerID: string; modelID: string; variant?: string | null }): void
  }
}

export const resetSessionModel = (local: Local) => {
  local.session.reset()
}

export const syncSessionModel = (local: Local, msg: UserMessage) => {
  local.session.restore(msg)
}

type SessionModel = { id: string; providerID: string; variant?: string }
export type PendingModelVariant = { id: string; providerID: string; variant: string | undefined }

export const syncAcceptedSessionModel = (
  local: ModelSelection,
  previous: SessionModel | undefined,
  next: SessionModel | undefined,
): PendingModelVariant | null | undefined => {
  if (!previous || !next) return undefined
  if (previous.id === next.id && previous.providerID === next.providerID) return undefined
  const current = local.model.current()
  if (current?.id !== previous.id || current.provider.id !== previous.providerID) return null
  local.model.set({ providerID: next.providerID, modelID: next.id })
  const variant = next.variant === "default" ? undefined : next.variant
  const selected = local.model.current()
  if (selected?.id !== next.id || selected.provider.id !== next.providerID) {
    return { id: next.id, providerID: next.providerID, variant }
  }
  local.model.variant.set(variant)
  return null
}

export const applyPendingModelVariant = (local: ModelSelection, pending: PendingModelVariant | null | undefined) => {
  const selected = local.model.current()
  if (!pending) return false
  if (selected?.id !== pending.id || selected.provider.id !== pending.providerID) return false
  local.model.variant.set(pending.variant)
  return true
}

export const syncAcceptedMessageModel = (
  local: ModelSelection,
  previous: UserMessage["model"] | undefined,
  next: UserMessage["model"] | undefined,
): PendingModelVariant | null | undefined => {
  if (!previous || !next) return undefined
  return syncAcceptedSessionModel(
    local,
    { id: previous.modelID, providerID: previous.providerID, variant: previous.variant },
    { id: next.modelID, providerID: next.providerID, variant: next.variant },
  )
}

export const syncPromptModel = (local: ModelSelection, prompt: PromptState) => {
  const model = local.model.current()
  if (!model) return
  const next = {
    providerID: model.provider.id,
    modelID: model.id,
    variant: local.model.variant.current(),
  }
  const current = prompt.model.current()
  if (current?.providerID === next.providerID && current.modelID === next.modelID && current.variant === next.variant)
    return
  prompt.model.set(next)
}

export const restorePromptModel = (local: ModelSelection, prompt: PromptState) => {
  const model = prompt.model.current()
  if (!model) return false
  const current = local.model.current()
  if (
    current?.provider.id === model.providerID &&
    current.id === model.modelID &&
    local.model.variant.current() === (model.variant ?? undefined)
  )
    return true
  local.model.set({ providerID: model.providerID, modelID: model.modelID })
  local.model.variant.set(model.variant ?? undefined)
  return true
}
