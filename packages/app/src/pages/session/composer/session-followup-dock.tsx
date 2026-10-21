import { For, Show, createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { DockTray } from "@opencode-ai/ui/dock-surface"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { useLanguage } from "@/context/language"

export function SessionFollowupDock(props: {
  items: { id: string; text: string }[]
  sending?: string
  onSend: (id: string) => void
  onEdit: (id: string) => void
}) {
  const language = useLanguage()
  const [store, setStore] = createStore({
    collapsed: false,
  })

  const toggle = () => setStore("collapsed", (value) => !value)
  const total = createMemo(() => props.items.length)
  const label = createMemo(() => language.plural("session.followupDock.summary", total()))
  const preview = createMemo(() => props.items[0]?.text ?? "")

  /*
   * ⚠ THIS USED TO MERGE INTO THE BOX BELOW IT — `margin-bottom: -0.875rem` with the bottom corners
   * squared off, so the two read as one surface. What sits below it now is `SessionCourseBar`, which
   * is transparent, so the negative margin pulled the breadcrumb 14px up into this card instead of
   * being covered by anything. Same defect as JOLLI-2572, reached through queued follow-ups rather
   * than the todo list. What stands in for it is `pb-2` on this dock's wrapper in
   * `session-composer-region.tsx` — the same 8px the todo and revert docks carry, and it belongs
   * there rather than here because the spacing is to whatever follows, not a property of the card.
   *
   * ⚠ THE SPACE THAT MERGE WAS HIDING GOES WITH IT — the 20px strip under the header and the 28px
   * of list padding below. Both existed to be overlapped; keeping them once nothing overlaps them
   * leaves a blank strip that makes this card TALLER than it was before the merge was removed.
   *
   * ⚠ IF A MERGE IS EVER WANTED BACK, USE `DockTray`'s `attach` PROP rather than inline styles —
   * `data-dock-attach="top"` in `dock-surface.css` is this exact rule, and `prompt-input.tsx` uses
   * it. The inline version here was a hand-rolled mirror of it.
   */
  return (
    <DockTray data-component="session-followup-dock">
      <div
        class="pl-3 pr-2 py-2 flex items-center gap-2"
        role="button"
        tabIndex={0}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return
          event.preventDefault()
          toggle()
        }}
      >
        <span class="shrink-0 text-13-medium text-text-strong cursor-default">{label()}</span>
        <Show when={store.collapsed && preview()}>
          <span class="min-w-0 flex-1 truncate text-13-regular text-text-base cursor-default">{preview()}</span>
        </Show>
        <div class="ml-auto shrink-0">
          <IconButton
            data-collapsed={store.collapsed ? "true" : "false"}
            icon="chevron-down"
            size="normal"
            variant="ghost"
            style={{ transform: `rotate(${store.collapsed ? 180 : 0}deg)` }}
            onMouseDown={(event) => {
              event.preventDefault()
              event.stopPropagation()
            }}
            onClick={(event) => {
              event.stopPropagation()
              toggle()
            }}
            aria-label={
              store.collapsed ? language.t("session.followupDock.expand") : language.t("session.followupDock.collapse")
            }
          />
        </div>
      </div>

      <Show when={!store.collapsed}>
        <div class="px-3 pb-3 flex flex-col gap-1.5 max-h-42 overflow-y-auto no-scrollbar">
          <For each={props.items}>
            {(item) => (
              <div class="flex items-center gap-2 min-w-0 py-1">
                <span class="min-w-0 flex-1 truncate text-13-regular text-text-strong">{item.text}</span>
                <Button
                  size="small"
                  variant="secondary"
                  class="shrink-0"
                  disabled={!!props.sending}
                  onClick={() => props.onSend(item.id)}
                >
                  {language.t("session.followupDock.sendNow")}
                </Button>
                <Button
                  size="small"
                  variant="ghost"
                  class="shrink-0"
                  disabled={!!props.sending}
                  onClick={() => props.onEdit(item.id)}
                >
                  {language.t("session.followupDock.edit")}
                </Button>
              </div>
            )}
          </For>
        </div>
      </Show>
    </DockTray>
  )
}
