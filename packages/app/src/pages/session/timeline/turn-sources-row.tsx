import { For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import type { JolliSources } from "@opencode-ai/core/jolli/sources"

/**
 * What one course turn drew on, drawn under its answer.
 *
 * ⚠ A MATERIAL IS NAMED, NOT LINKED. A student opens course materials from the course page, and
 * this row only knows a material's id and title; a link would have to guess a route on the web.
 */
export function TimelineSourcesRow(props: { sources: JolliSources.TurnSources }) {
  const language = useLanguage()

  return (
    <div data-slot="session-turn-sources" class="flex flex-col gap-1 text-12-regular text-text-weak">
      <Show when={props.sources.materials.length > 0}>
        <div data-slot="session-turn-sources-materials" class="flex flex-wrap gap-x-2 gap-y-1">
          <span class="shrink-0">{language.t("session.sources.materials")}</span>
          <For each={props.sources.materials}>
            {(material) => <span class="text-text-strong break-words">{material.title}</span>}
          </For>
        </div>
      </Show>
      <Show when={props.sources.web.length > 0}>
        <div data-slot="session-turn-sources-web" class="flex flex-wrap gap-x-2 gap-y-1">
          <span class="shrink-0">{language.t("session.sources.web")}</span>
          <For each={props.sources.web}>
            {(page) => (
              <a
                class="text-text-strong break-all hover:underline"
                href={page.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                {page.title}
              </a>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}
