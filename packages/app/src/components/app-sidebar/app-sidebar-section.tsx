/**
 * ONE OF THE SIDEBAR'S THREE LABELLED SECTIONS.
 *
 * ⚠ THE HEADER GEOMETRY IS COPIED FROM THE TWO HEADERS THIS REPLACED — the Courses label and the
 * Projects label, which were written separately and happened to agree. Three sections stacked in one
 * column have to read as siblings, and "they happened to agree" is not a property that survives the
 * next edit to one of them.
 *
 * ⚠ THE DISCLOSURE IS A BUTTON AND THE ACTION IS ITS SIBLING, NEVER ITS CHILD. A button inside a
 * button is invalid, and the click would run both. This is the same arrangement the project rows
 * use for their hover menu.
 */

import { Show, type JSX } from "solid-js"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { useLayout } from "@/context/layout"

export type AppSidebarSectionId = "courses" | "sessions" | "projects"

export function AppSidebarSection(props: {
  id: AppSidebarSectionId
  label: string
  /**
   * THE DISCLOSURE'S LABELS, AS WHOLE SENTENCES.
   *
   * ⚠ PASSED IN RATHER THAN BUILT FROM `label`, WHICH IS AN I18N REQUIREMENT AND NOT A STYLE
   * CHOICE. "Collapse {{section}}" declines wrongly in most of the sixty-one languages this ships
   * in — the interpolated noun needs a case or gender the template cannot know. Every other
   * collapsible surface here states its own sentence (`home.server.collapse`,
   * `session.todo.collapse`, `session.followupDock.collapse`), and `SessionTodoDock` takes them as
   * props for exactly this reason. Absent when the section does not collapse.
   */
  collapseLabel?: string
  expandLabel?: string
  /** Takes the height the other sections leave behind, and scrolls inside it. At most one section. */
  grow?: boolean
  /** A control that belongs to the section rather than to any row: add-project, new-session. */
  action?: JSX.Element
  children: JSX.Element
}) {
  const layout = useLayout()
  /**
   * ⚠ NOT EVERY SECTION COLLAPSES. Sessions owns the column's leftover height, so collapsing it
   * would produce dead space rather than reclaim any — see `grow`. Having the labels IS being
   * collapsible, so the two cannot disagree.
   */
  const collapsible = () => !!props.collapseLabel && !!props.expandLabel
  const collapsed = () => (collapsible() ? layout.sidebar.sectionCollapsed(props.id)() : false)

  return (
    <section
      data-component="app-sidebar-section"
      data-section={props.id}
      class="flex min-w-0 flex-col gap-1"
      classList={{ "min-h-0 flex-1": props.grow, "shrink-0": !props.grow }}
      aria-label={props.label}
    >
      <div class="flex h-7 min-w-0 shrink-0 items-center gap-1 pl-1.5 pr-1">
        <Show
          when={collapsible()}
          fallback={<div class="text-v2-text-text-muted [font-weight:530]">{props.label}</div>}
        >
          <button
            type="button"
            data-action="app-sidebar-section-toggle"
            aria-expanded={!collapsed()}
            aria-label={collapsed() ? props.expandLabel : props.collapseLabel}
            class={`
              -ml-1 flex h-6 min-w-0 cursor-default items-center gap-0.5 rounded-[4px] pl-0.5 pr-1
              text-v2-text-text-muted [font-weight:530]
              hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base
              focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none
            `}
            onClick={() => layout.sidebar.toggleSection(props.id)}
          >
            <IconV2
              name="chevron-down"
              size="small"
              class="shrink-0 text-v2-icon-icon-muted transition-transform duration-150 ease-in-out"
              style={{ transform: `rotate(${collapsed() ? -90 : 0}deg)` }}
            />
            <span class="min-w-0 truncate">{props.label}</span>
          </button>
        </Show>
        <div class="flex-1" />
        {props.action}
      </div>
      {/*
       * ⚠ THE BODY IS UNMOUNTED WHEN COLLAPSED RATHER THAN HIDDEN. A collapsed Projects section
       * still holding a live `@dnd-kit` drag context and a row per project costs the same as an
       * open one, and a hidden row is still a tab stop unless something says otherwise.
       */}
      <Show when={!collapsed()}>{props.children}</Show>
    </section>
  )
}
