import { createMemo, createUniqueId, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type { Jolli } from "@opencode-ai/schema/jolli"
import { useLanguage } from "@/context/language"
import {
  groupChatSourceGroups,
  groupChatSourceUrl,
  type GroupChatSource,
  type GroupChatLocator,
} from "@/jolli/group-chat-sources"

export function GroupChatSources(props: {
  sources: readonly GroupChatSource[]
  chat: Jolli.GroupChat
  staff: boolean
  onOpen: (source: GroupChatSource, trigger: HTMLButtonElement, url: string) => void
}) {
  const language = useLanguage()
  const titleId = createUniqueId()
  const listId = createUniqueId()
  const [state, setState] = createStore({ count: 10 })
  const groups = createMemo(() => groupChatSourceGroups(props.sources))
  const location = (locator: GroupChatLocator | undefined) => {
    if (!locator) return undefined
    if (locator.kind === "heading") return locator.path.join(" › ")
    if (locator.kind === "timecode")
      return `${Math.floor(locator.seconds / 60)}:${String(Math.floor(locator.seconds % 60)).padStart(2, "0")}`
    if (locator.kind === "ordinal") return language.t("groupChat.sources.excerpt", { index: locator.index })
    return locator.lastPage && locator.lastPage > locator.page
      ? language.t("groupChat.sources.pages", { first: locator.page, last: locator.lastPage })
      : language.t("groupChat.sources.page", { page: locator.page })
  }
  const chip = (source: GroupChatSource, excerpt = false, index = 0) => {
    const url = () => groupChatSourceUrl(source, props.chat, props.staff)
    const updated = source.kind === "material" && source.unavailable && source.replacedBy && !source.assignment
    const where = source.kind === "material" ? location(source.locator) : undefined
    const label = () => {
      if (!excerpt) return source.kind === "student_work" ? (source.assignmentTitle ?? source.title) : source.title
      if (source.kind === "student_work")
        return [source.task, language.t(`session.sources.${source.category}`)].filter(Boolean).join(" · ")
      if (
        where?.replace(/[\p{P}\p{Z}\s]/gu, "").toLowerCase() ===
        source.title.replace(/[\p{P}\p{Z}\s]/gu, "").toLowerCase()
      )
        return language.t("groupChat.sources.excerpt", { index: index + 1 })
      return where
    }
    const reason = () =>
      updated
        ? language.t("groupChat.sources.updated")
        : source.kind === "material" && source.unavailable
          ? language.t("groupChat.sources.unavailable")
          : source.kind === "material" && !source.assignment && source.studentAccess !== "download"
            ? language.t("groupChat.sources.withheld")
            : undefined
    return (
      <button
        type="button"
        class="group-chat-citation"
        classList={{ "group-chat-citation-excerpt": excerpt }}
        data-testid={excerpt ? "group-chat-citation-excerpt" : "group-chat-citation"}
        disabled={!url()}
        title={reason() ?? (excerpt ? (where ?? source.title) : source.title)}
        aria-label={excerpt ? `${source.title} · ${label()}` : label()}
        onClick={(event) => {
          const address = url()
          if (address) props.onOpen(source, event.currentTarget, address.href)
        }}
      >
        <Show when={!excerpt}>
          <ReferenceIcon
            kind={
              !url()
                ? "lock"
                : source.kind === "web" || (source.kind === "material" && source.sourceUrl)
                  ? "web"
                  : "file"
            }
          />
        </Show>
        <span class="group-chat-citation-label">{label()}</span>
        <Show when={!excerpt && source.kind === "material" && source.linkTitle}>
          <span class="group-chat-citation-site">{source.kind === "material" && source.linkTitle}</span>
        </Show>
        <Show when={updated}>
          <span class="group-chat-citation-updated">{language.t("groupChat.sources.updated")}</span>
        </Show>
      </button>
    )
  }
  return (
    <Show when={groups().length > 0}>
      <section class="group-chat-sources" data-slot="group-chat-sources" aria-labelledby={titleId}>
        <h3 id={titleId}>
          <ReferenceIcon kind="book" />
          {language.t("session.sources.references")}
        </h3>
        <div id={listId} class="group-chat-source-list">
          <For each={groups().slice(0, state.count)}>
            {(group) => (
              <div class="group-chat-source-group" data-source-key={group.key}>
                {chip(group.source)}
                <For each={group.excerpts}>
                  {(source, index) =>
                    chip(
                      source.kind === "material" && group.source.kind === "material"
                        ? { ...group.source, locator: source.locator }
                        : source,
                      true,
                      index(),
                    )
                  }
                </For>
              </div>
            )}
          </For>
        </div>
        <Show when={groups().length > 10}>
          <button
            type="button"
            class="group-chat-sources-toggle"
            aria-controls={listId}
            aria-expanded={state.count > 10}
            onClick={() => setState("count", state.count >= groups().length ? 10 : state.count + 10)}
          >
            {language.t(state.count >= groups().length ? "groupChat.sources.less" : "groupChat.sources.more")}
          </button>
        </Show>
      </section>
    </Show>
  )
}

function ReferenceIcon(props: { kind: "book" | "file" | "lock" | "web" }) {
  const paths = {
    book: "M12 7v14m0-14C9 4 5 3 2 3v16c4 0 7 1 10 2 3-1 6-2 10-2V3c-3 0-7 1-10 4Z",
    file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Zm0 0v6h6M8 13h8m-8 4h6",
    lock: "M7 11V7a5 5 0 0 1 10 0v4M5 11h14v11H5Z",
    web: "M2 12h20M12 2a18 18 0 0 1 0 20 18 18 0 0 1 0-20Zm10 10a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z",
  }
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d={paths[props.kind]} />
    </svg>
  )
}
