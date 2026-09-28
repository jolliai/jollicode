import type { Provider } from "@opencode-ai/sdk/v2"

export function parse(value: string) {
  const [providerID, ...modelID] = value.split("/")
  return { providerID, modelID: modelID.join("/") }
}

export function index(list: Provider[] | undefined) {
  return new Map((list ?? []).map((item) => [item.id, item] as const))
}

export function get(list: Provider[] | ReadonlyMap<string, Provider> | undefined, providerID: string, modelID: string) {
  const provider =
    list instanceof Map
      ? list.get(providerID)
      : Array.isArray(list)
        ? list.find((item) => item.id === providerID)
        : undefined
  return provider?.models[modelID]
}

export function name(
  list: Provider[] | ReadonlyMap<string, Provider> | undefined,
  providerID: string,
  modelID: string,
) {
  return get(list, providerID, modelID)?.name ?? modelID
}

type Selection = { providerID: string; modelID: string; variant?: string }

export function syncAcceptedModel(
  local: {
    model: {
      current(): { providerID: string; modelID: string } | undefined
      set(model: { providerID: string; modelID: string }): void
      variant: { set(variant: string | undefined): void }
    }
  },
  previous: Selection | undefined,
  next: Selection | undefined,
) {
  if (!previous || !next) return
  if (previous.providerID === next.providerID && previous.modelID === next.modelID) return
  const current = local.model.current()
  if (current?.providerID !== previous.providerID || current.modelID !== previous.modelID) return
  local.model.set({ providerID: next.providerID, modelID: next.modelID })
  const selected = local.model.current()
  if (selected?.providerID !== next.providerID || selected.modelID !== next.modelID) return
  local.model.variant.set(next.variant === "default" ? undefined : next.variant)
}
