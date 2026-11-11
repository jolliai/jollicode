import { createMemo, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type { Schema } from "effect"
import { useLanguage } from "@/context/language"
import { ReferenceMarkdown } from "./reference-markdown"
import { referenceMindMap, referenceMindMapLayout, type ReferenceMapTopic } from "@/jolli/reference-mindmap"
import type { ReferencePreview } from "@/jolli/reference-preview"
import { safeReferenceUrl } from "@/jolli/external-link"

export function ReferenceMindMapViewer(props: { data: Schema.Json; onOpen: (item: ReferencePreview) => void }) {
  const language = useLanguage()
  const [state, setState] = createStore<{
    view: "map" | "outline"
    folded: Record<string, boolean>
    selected?: ReferenceMapTopic
    zoom: number
  }>({ view: "map", folded: {}, zoom: 1 })
  const map = createMemo(() => referenceMindMap(props.data))
  const collapsed = createMemo(() => {
    const result = new Set<string>()
    const visit = (topic: ReferenceMapTopic) => {
      if (state.folded[`topic:${topic.id}`] ?? topic.collapsed) result.add(topic.id)
      topic.children.forEach(visit)
    }
    map().roots.forEach(visit)
    return result
  })
  const layout = createMemo(() => referenceMindMapLayout(map().roots, collapsed()))
  const choose = (topic: ReferenceMapTopic) => {
    setState("selected", topic)
    if (topic.children.length) setState("folded", `topic:${topic.id}`, !collapsed().has(topic.id))
  }
  const outline = (topic: ReferenceMapTopic) => (
    <li>
      <details
        open={!collapsed().has(topic.id)}
        onToggle={(event) => setState("folded", `topic:${topic.id}`, !event.currentTarget.open)}
      >
        <summary onClick={() => setState("selected", topic)}>{topic.text}</summary>
        <ul>
          <For each={topic.children}>{outline}</For>
        </ul>
      </details>
    </li>
  )
  return (
    <div class="reference-map">
      <div class="reference-viewer-toolbar">
        <button type="button" aria-pressed={state.view === "map"} onClick={() => setState("view", "map")}>
          {language.t("groupChat.preview.map")}
        </button>
        <button type="button" aria-pressed={state.view === "outline"} onClick={() => setState("view", "outline")}>
          {language.t("groupChat.preview.outline")}
        </button>
        <button
          type="button"
          aria-label={language.t("groupChat.preview.zoomOut")}
          disabled={state.zoom <= 0.25}
          onClick={() => setState("zoom", state.zoom / 1.25)}
        >
          −
        </button>
        <button
          type="button"
          aria-label={language.t("groupChat.preview.zoomIn")}
          disabled={state.zoom >= 2}
          onClick={() => setState("zoom", state.zoom * 1.25)}
        >
          +
        </button>
      </div>
      <Show when={map().partial}>
        <p class="reference-notice">{language.t("groupChat.preview.partial")}</p>
      </Show>
      <Show
        when={state.view === "map"}
        fallback={
          <ul class="reference-mindmap">
            <For each={map().roots}>{outline}</For>
          </ul>
        }
      >
        <div class="reference-map-canvas">
          <svg
            width={layout().width * state.zoom}
            height={layout().height * state.zoom}
            viewBox={`0 0 ${layout().width} ${layout().height}`}
            role="img"
            aria-label={language.t("groupChat.preview.map")}
          >
            <For each={layout().edges}>
              {(edge) => (
                <path
                  d={`M${edge.from.x},${edge.from.y} C${edge.from.x + 16},${edge.from.y} ${edge.to.x - 16},${edge.to.y} ${edge.to.x},${edge.to.y}`}
                  fill="none"
                  stroke="var(--v2-border-border-muted)"
                  stroke-width="2"
                />
              )}
            </For>
            <For each={layout().nodes}>
              {(node) => (
                <g
                  role="button"
                  tabIndex={0}
                  aria-label={node.topic.text}
                  aria-expanded={node.topic.children.length ? !collapsed().has(node.topic.id) : undefined}
                  onClick={() => choose(node.topic)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault()
                      choose(node.topic)
                    }
                  }}
                >
                  <title>{node.topic.text}</title>
                  <rect
                    x={node.x}
                    y={node.y}
                    width="200"
                    height="48"
                    rx="8"
                    fill="var(--v2-background-bg-layer-01)"
                    stroke={
                      state.selected?.id === node.topic.id
                        ? "var(--v2-border-border-focus)"
                        : "var(--v2-border-border-muted)"
                    }
                  />
                  <foreignObject x={node.x + 12} y={node.y + 6} width="176" height="36">
                    <div class="reference-map-label">{node.topic.text}</div>
                  </foreignObject>
                </g>
              )}
            </For>
          </svg>
        </div>
      </Show>
      <Show when={state.selected}>
        {(topic) => (
          <section class="reference-markdown reference-map-detail">
            <strong>{topic().text}</strong>
            <Show when={topic().notes}>
              <ReferenceMarkdown text={topic().notes ?? ""} />
            </Show>
            <Show when={safeReferenceUrl(topic().image)}>
              {(url) => <img class="reference-image" src={url()} alt={topic().text} referrerPolicy="no-referrer" />}
            </Show>
            <For each={topic().parts}>
              {(part) => (
                <button
                  type="button"
                  class="reference-action"
                  onClick={() =>
                    props.onOpen({
                      key: `material:${part.id}`,
                      title: part.title,
                      reference: { kind: "material", materialId: part.id },
                    })
                  }
                >
                  {part.title}
                </button>
              )}
            </For>
          </section>
        )}
      </Show>
    </div>
  )
}
