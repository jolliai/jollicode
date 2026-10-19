import { For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import type { JolliSources } from "@opencode-ai/core/jolli/sources"
import { Icon } from "@opencode-ai/ui/icon"

/**
 * Under a course turn that asked about assignments its agent does not read: the way to the course's
 * Assignments page. The answer says it cannot look them up; this is where the student can.
 *
 * Keep the native anchor so students can open, copy, or middle-click the destination.
 */
export function TimelineAssignmentsLinkRow(props: { url: string }) {
  const language = useLanguage()

  return (
    <div data-slot="session-turn-assignments-link" class="flex">
      <a
        class="inline-flex min-h-6 items-center gap-1 rounded-sm px-1.5 py-0.5 text-[11px] leading-4 font-[560] text-v2-text-text-accent hover:text-v2-text-text-accent-hover hover:underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-v2-border-border-focus"
        href={props.url}
        target="_blank"
        rel="noopener noreferrer"
      >
        <Icon name="checklist" size="small" class="size-3.5 shrink-0 text-v2-text-text-accent" aria-hidden="true" />
        {language.t("session.sources.assignments")}
      </a>
    </div>
  )
}

/**
 * What one course turn drew on, drawn under its answer.
 *
 * Ordinary materials carry a title only. An assignment also carries the worksheet URL supplied
 * by the course server, so its citation can open that worksheet without guessing the tenant.
 */
export function TimelineSourcesRow(props: { sources: JolliSources.TurnSources }) {
  const language = useLanguage()

  return (
    <div data-slot="session-turn-sources" class="flex flex-col gap-1 text-12-regular text-text-weak">
      <Show when={props.sources.materials.length > 0}>
        <div data-slot="session-turn-sources-materials" class="flex flex-wrap gap-x-2 gap-y-1">
          <span class="shrink-0">{language.t("session.sources.materials")}</span>
          <For each={props.sources.materials}>
            {(material) => (
              <Show when={material.url} fallback={<span class="text-text-strong break-words">{material.title}</span>}>
                {(url) => (
                  <a
                    class="text-text-strong break-words hover:underline"
                    href={url()}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {material.title}
                  </a>
                )}
              </Show>
            )}
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
