import { createUniqueId, For, Show, Suspense, lazy, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { Icon } from "@opencode-ai/ui/icon"
import type { Jolli } from "@opencode-ai/schema/jolli"
import type { ServerSDK } from "@/context/server-sdk"
import type { ReferencePreview } from "@/jolli/reference-preview"
import { guardExternalLinks } from "@/jolli/external-link"
import { useLanguage } from "@/context/language"
import { useExternalLinkConfirm } from "./external-link-confirm"

const ReferencePreviewContent = lazy(() =>
  import("./reference-preview-content").then((module) => ({ default: module.ReferencePreviewContent })),
)

export function ReferenceDock(props: {
  sdk: ServerSDK
  target: Jolli.ReferenceTarget
  items: readonly ReferencePreview[]
  active: ReferencePreview
  opening: number
  expanded: boolean
  width: number
  onActivate: (item: ReferencePreview) => void
  onClose: (key: string) => void
  onOpen: (item: ReferencePreview) => void
  onExpand: () => void
  onResize: (width: number) => void
}) {
  const language = useLanguage()
  const openLink = useExternalLinkConfirm()
  const panelId = createUniqueId()
  const [elements, setElements] = createStore<{ actions?: HTMLDivElement }>({})
  let stopResize: (() => void) | undefined
  onCleanup(() => stopResize?.())
  let dock: HTMLElement | undefined
  // Every reader draws shared content in this pane, so no link in it leaves before its full address is confirmed.
  onMount(() => {
    if (dock) onCleanup(guardExternalLinks(dock, { open: (url) => void openLink(url) }))
  })
  const resize = (event: PointerEvent) => {
    if (event.button !== 0) return
    const start = event.clientX
    const width =
      event.currentTarget instanceof HTMLElement
        ? (event.currentTarget.nextElementSibling?.getBoundingClientRect().width ?? props.width)
        : props.width
    const move = (event: PointerEvent) =>
      props.onResize(Math.max(320, Math.min(window.innerWidth * 0.7, width + start - event.clientX)))
    const stop = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", stop)
    }
    stopResize?.()
    stopResize = stop
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", stop, { once: true })
    event.preventDefault()
  }
  return (
    <>
      <div
        class="group-chat-reference-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label={language.t("groupChat.preview.resize")}
        tabIndex={0}
        aria-valuemin={320}
        aria-valuemax={Math.round(window.innerWidth * 0.7)}
        aria-valuenow={Math.round(props.width)}
        onPointerDown={resize}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault()
            props.onResize(
              Math.max(320, Math.min(window.innerWidth * 0.7, props.width + (event.key === "ArrowLeft" ? 16 : -16))),
            )
          }
        }}
      />
      <aside
        ref={dock}
        class="group-chat-reference-dock"
        style={{ width: props.expanded ? "100%" : `${props.width}px` }}
        aria-label={language.t("session.sources.references")}
        data-testid="group-chat-reference-dock"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault()
            props.onClose(props.active.key)
          }
        }}
      >
        <header class="group-chat-reference-header">
          <div
            class="group-chat-reference-tabs"
            role="tablist"
            aria-label={language.t("session.sources.references")}
            onKeyDown={(event) => {
              const index = props.items.findIndex((item) => item.key === props.active.key)
              const next =
                event.key === "ArrowRight"
                  ? (index + 1) % props.items.length
                  : event.key === "ArrowLeft"
                    ? (index - 1 + props.items.length) % props.items.length
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? props.items.length - 1
                        : undefined
              if (next === undefined) return
              event.preventDefault()
              props.onActivate(props.items[next])
              const tabs = event.currentTarget
              queueMicrotask(() => tabs.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus())
            }}
          >
            <For each={props.items}>
              {(item) => (
                <div
                  class="group-chat-reference-tab"
                  classList={{ "group-chat-reference-tab-active": props.active.key === item.key }}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={props.active.key === item.key}
                    aria-controls={panelId}
                    tabIndex={props.active.key === item.key ? 0 : -1}
                    title={item.title}
                    onClick={() => props.onActivate(item)}
                  >
                    {item.title}
                  </button>
                  <button
                    type="button"
                    class="group-chat-reference-close-tab"
                    aria-label={language.t("groupChat.preview.closeTitled", { title: item.title })}
                    onClick={() => props.onClose(item.key)}
                  >
                    ×
                  </button>
                </div>
              )}
            </For>
          </div>
          <div ref={(actions) => setElements("actions", actions)} class="reference-header-actions" />
          <button
            type="button"
            class="reference-icon-button"
            aria-label={language.t("groupChat.preview.reload")}
            onClick={() => props.onActivate(props.active)}
          >
            <Icon name="reset" size="small" />
          </button>
          <Show when={props.active.url}>
            {(url) => (
              <button
                type="button"
                class="reference-icon-button"
                aria-label={language.t("groupChat.preview.openOriginal")}
                onClick={() => void openLink(url())}
              >
                <Icon name="open-file" size="small" />
              </button>
            )}
          </Show>
          <button
            type="button"
            class="reference-icon-button"
            aria-label={language.t(props.expanded ? "groupChat.preview.restore" : "groupChat.preview.expand")}
            onClick={props.onExpand}
          >
            <Icon name={props.expanded ? "collapse" : "expand"} size="small" />
          </button>
        </header>
        <div id={panelId} role="tabpanel" class="group-chat-reference-body" aria-label={props.active.title}>
          <Show when={`${props.active.key}:${props.opening}`} keyed>
            {(_opening) => (
              <Suspense fallback={<p class="reference-notice">{language.t("groupChat.preview.loading")}</p>}>
                <ReferencePreviewContent
                  sdk={props.sdk}
                  target={props.target}
                  item={props.active}
                  onOpen={props.onOpen}
                  actions={elements.actions}
                />
              </Suspense>
            )}
          </Show>
        </div>
      </aside>
    </>
  )
}
