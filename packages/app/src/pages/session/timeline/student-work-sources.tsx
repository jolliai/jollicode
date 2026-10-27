import { For, Show, createMemo } from "solid-js"
import { JolliSources } from "@opencode-ai/core/jolli/sources"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"

function categoryKey(source: JolliSources.StudentWorkSource) {
  switch (source.category) {
    case "record":
      return "session.sources.record"
    case "submission":
      return "session.sources.submission"
    case "reflection":
      return "session.sources.reflection"
    default:
      return "session.sources.feedback"
  }
}

function WorkReference(props: { source: JolliSources.StudentWorkSource }) {
  const language = useLanguage()
  const category = () => language.t(categoryKey(props.source))
  const title = () => (props.source.taskId === undefined ? category() : props.source.title)
  const body = () => (
    <>
      <Icon
        name={props.source.category === "feedback" ? "comment" : "checklist"}
        size="small"
        class="shrink-0 text-text-weak"
        aria-hidden="true"
      />
      <span class="min-w-0 flex-1">
        <span class="block break-words font-medium leading-5 [overflow-wrap:anywhere]">{title()}</span>
      </span>
      <Show when={props.source.taskId !== undefined && props.source.category !== "submission"}>
        <span class="shrink-0 rounded bg-surface-base-hover px-1 py-0.5 text-[10px] leading-3 text-text-weak">
          {category()}
        </span>
      </Show>
      <Show when={props.source.url}>
        <Icon name="open-file" size="small" class="shrink-0 text-text-weak" aria-hidden="true" />
      </Show>
    </>
  )
  const style = "flex min-h-8 min-w-0 items-center gap-2 rounded px-2 py-1 pointer-coarse:min-h-11 text-text-strong"
  return (
    <Show when={props.source.url} fallback={<span class={style}>{body()}</span>}>
      {(url) => (
        <a
          class={`${style} transition-colors hover:bg-surface-base-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-v2-border-border-focus motion-reduce:transition-none`}
          href={url()}
          target="_blank"
          rel="noopener noreferrer"
          title={props.source.title}
          aria-label={language.t("session.sources.openWork", { title: props.source.title, category: category() })}
        >
          {body()}
        </a>
      )}
    </Show>
  )
}

/** One card per assignment, with files and other evidence grouped under their original tasks. */
export function StudentWorkSources(props: {
  sources: readonly JolliSources.StudentWorkSource[]
  worksheets?: readonly Extract<JolliSources.AnswerSource, { kind: "material" }>[]
}) {
  const language = useLanguage()
  const groups = createMemo(() => JolliSources.groupStudentWorkSources(props.sources, props.worksheets))
  return (
    <div class="flex min-w-0 flex-wrap items-start gap-2">
      <For each={groups()}>
        {(group) => {
          const title = () => group.assignmentTitle ?? language.t("session.sources.assignment")
          const header = () => (
            <>
              <span class="flex shrink-0 items-center text-v2-text-text-accent">
                <Icon name="checklist" size="small" aria-hidden="true" />
              </span>
              <span class="min-w-0 flex-1 break-words font-semibold leading-5 text-text-strong [overflow-wrap:anywhere]">
                {title()}
              </span>
              <span class="rounded-md border border-border-weak-base px-1.5 py-0.5 tabular-nums text-text-weak">
                {group.sourceCount}
              </span>
              <Show when={group.assignmentUrl}>
                <Icon name="open-file" size="small" class="shrink-0 text-text-weak" aria-hidden="true" />
              </Show>
            </>
          )
          const headerStyle =
            "flex min-h-7 items-center gap-2 border-b border-border-weak-base bg-surface-base-hover/40 px-2.5 py-1 pointer-coarse:min-h-11"
          return (
            <div
              class="w-fit min-w-0 max-w-sm overflow-hidden rounded-lg border border-border-weak-base bg-background-base"
              data-slot="assignment-reference-card"
            >
              <Show when={group.assignmentUrl} fallback={<div class={headerStyle}>{header()}</div>}>
                {(url) => (
                  <a
                    class={`${headerStyle} transition-colors hover:bg-surface-base-hover focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-v2-border-border-focus motion-reduce:transition-none`}
                    href={url()}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={language.t("session.sources.openWork", {
                      title: title(),
                      category: language.t("session.sources.assignment"),
                    })}
                  >
                    {header()}
                  </a>
                )}
              </Show>
              <div class="divide-y divide-border-weak-base px-1 py-0.5">
                <Show when={group.worksheet}>
                  <span class="block px-2 py-1.5 text-[11px] text-text-weak">
                    {language.t("session.sources.worksheet")}
                  </span>
                </Show>
                <For each={group.tasks}>
                  {(task) => (
                    <div class="flex min-w-0 items-start gap-0.5 py-0.5" data-slot="assignment-reference-task">
                      <Show when={task.taskId !== undefined}>
                        <span
                          title={task.task}
                          class="ml-1.5 mt-2 shrink-0 rounded bg-surface-base-hover px-1.5 py-0.5 text-[10px] font-medium leading-3 text-text-weak"
                        >
                          {task.taskPosition === undefined
                            ? language.t("session.sources.task")
                            : language.t("dialog.assignment.task.title", { number: String(task.taskPosition) })}
                        </span>
                      </Show>
                      <div class="min-w-0 flex-1">
                        <For each={task.sources}>{(source) => <WorkReference source={source} />}</For>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </div>
          )
        }}
      </For>
    </div>
  )
}
