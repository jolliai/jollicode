import { createContext, createMemo, Show, useContext, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { useLocation } from "@solidjs/router"
import { Jolli } from "@opencode-ai/schema/jolli"
import { useServerSDK } from "./server-sdk"
import { ReferenceDock } from "@/components/reference-dock"
import { scopedReferencePreview, type ReferencePreview } from "@/jolli/reference-preview"
import "@/components/reference-preview.css"

type PreviewState = {
  items: ReferencePreview[]
  active?: string
  target?: Jolli.ReferenceTarget
  opening: number
  width: number
  expanded: boolean
}
type OpenReference = (target: Jolli.ReferenceTarget, item: ReferencePreview, trigger?: HTMLElement) => void
const ReferenceContext = createContext<{ open: OpenReference }>()

export function useReferencePreview() {
  return useContext(ReferenceContext)
}

/**
 * Every conversation uses the same reference readers and pane, with independent tab state per route.
 *
 * Only the group chat route mounts it so far, and that page still runs its own dock and its own
 * `.group-chat-workspace`, so `open` has no caller yet and this wrapper contributes only its flex
 * container. Moving the page onto `useReferencePreview` changes the nesting the dock's layout rules
 * select on, so it waits for a change that checks that layout.
 */
export function ReferenceWorkspace(props: ParentProps) {
  const sdk = useServerSDK()
  const location = useLocation()
  const [state, setState] = createStore<{ views: Record<string, PreviewState> }>({ views: {} })
  const route = () => location.pathname
  const current = (): PreviewState | undefined => state.views[route()]
  const active = createMemo(() => current()?.items.find((item) => item.key === current()?.active))
  const triggers = new Map<string, WeakRef<HTMLElement>>()
  const open: OpenReference = (target, item, trigger) => {
    const selected = scopedReferencePreview(target, item)
    if (!current()) setState("views", route(), { items: [], opening: 0, width: 480, expanded: false })
    if (trigger) triggers.set(`${route()}:${selected.key}`, new WeakRef(trigger))
    setState("views", route(), "items", (items) =>
      items.some((entry) => entry.key === selected.key)
        ? items.map((entry) => (entry.key === selected.key ? selected : entry))
        : [...items, selected],
    )
    setState("views", route(), {
      active: selected.key,
      target: selected.target,
      opening: (current()?.opening ?? 0) + 1,
    })
  }
  const close = (key: string) => {
    setState("views", route(), "items", (items) => items.filter((item) => item.key !== key))
    if (current()?.active === key) setState("views", route(), { active: current()?.items.at(-1)?.key, expanded: false })
    triggers.get(`${route()}:${key}`)?.deref()?.focus()
    triggers.delete(`${route()}:${key}`)
  }
  return (
    <ReferenceContext.Provider value={{ open }}>
      <div
        class="group-chat-workspace"
        classList={{ "group-chat-workspace-expanded": !!active() && current()?.expanded }}
      >
        <div class="conversation-reference-main">{props.children}</div>
        <Show when={active()}>
          {(item) => (
            <ReferenceDock
              sdk={sdk()}
              target={item().target ?? current()!.target!}
              items={current()!.items}
              active={item()}
              opening={current()!.opening}
              width={current()!.width}
              expanded={current()!.expanded}
              onOpen={(next) => open(item().target ?? current()!.target!, next)}
              onActivate={(item) => open(item.target ?? current()!.target!, item)}
              onClose={close}
              onExpand={() => setState("views", route(), "expanded", !current()?.expanded)}
              onResize={(width) => setState("views", route(), "width", width)}
            />
          )}
        </Show>
      </div>
    </ReferenceContext.Provider>
  )
}
