/**
 * THE APPLICATION'S PERMANENT LEFT COLUMN: courses, sessions, projects, account.
 *
 * ⚠ IT IS THE NAVIGATION NOW, NOT AN EXTRA. The previous shell put session navigation in a
 * browser-style tab strip in the titlebar and kept these three lists on the home page, which meant
 * they vanished the moment you opened a session. That is why `layout.sidebar.opened` defaults to
 * true and why older installs are migrated open — see `context/layout-migration.ts`.
 *
 * ⚠ SECTION ORDER IS COARSE TO FINE, AND IT IS THE POINT OF THE COLUMN. A student has two or three
 * courses, a few dozen sessions and a handful of repositories; the course is what they orient by
 * first, the session is the work itself, and the project is where that work happens to live.
 *
 * ⚠ THE DATA COMES FROM `useHomeData()` RATHER THAN FROM PROPS. Those controllers are application
 * scoped precisely so this component and the home page cannot disagree about the focused server or
 * the course filter — see `context/home-data.tsx`.
 */

import { createMemo } from "solid-js"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { KeybindV2 } from "@opencode-ai/ui/v2/keybind-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { newTabTooltipKeybind } from "@/components/command-tooltip-keybind"
import { useCommand } from "@/context/command"
import { useHomeData } from "@/context/home-data"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { listedCourses } from "@/jolli/catalog"
import { HomeProjectsListBody } from "@/pages/home/home-projects-view"
import { homeProjectsViewProps } from "@/pages/home/home-projects"
import { createSizing } from "@/pages/session/helpers"
import { AppSidebarAccount } from "./app-sidebar-account"
import { AppSidebarCourses } from "./app-sidebar-courses"
import { AppSidebarSection } from "./app-sidebar-section"
import { AppSidebarSessions } from "./app-sidebar-sessions"
import "./app-sidebar.css"

const SIDEBAR_MIN_WIDTH = 240
const SIDEBAR_MAX_WIDTH = 480

export function AppSidebar() {
  const layout = useLayout()
  const language = useLanguage()
  const command = useCommand()
  const { home, projects, sessions, search } = useHomeData()
  /**
   * ⚠ THE TRANSITION IS SUPPRESSED WHILE DRAGGING, which is the same trick the review panel uses —
   * animating width on every mousemove makes the handle feel like it is on elastic.
   *
   * ⚠ AND IT USES `createSizing` RATHER THAN A SIGNAL FLIPPED FROM `ResizeHandle`'s CALLBACKS,
   * because those cannot say when a drag ended: `onCollapseChange(false)` fires both on mouseup of
   * an ordinary drag and mid-drag when the pointer crosses back above the collapse threshold. This
   * helper ends the drag on `pointerup`, `pointercancel` and `blur`, so a drag interrupted by an
   * alt-tab does not leave the transition switched off forever.
   */
  const sizing = createSizing()
  const opened = () => layout.sidebar.opened()

  /**
   * PREVIOUS AND NEXT CHAT — THE TITLEBAR'S TWO ARROWS, AND `alt+↑`/`alt+↓`.
   *
   * ⚠ THEY ARE REGISTERED HERE BECAUSE THE NEW SHELL NEVER MOUNTS THE LAYOUT THAT USED TO OWN
   * THEM. `pages/layout.tsx` still defines `session.previous`/`session.next` over its own
   * project-scoped session list, but `NewAppLayout` renders `layout-new.tsx` instead and the
   * `/:dir/session/:id` route those commands came with is no longer the one the application uses.
   * So both ids resolved to no command at all: `command.trigger` found nothing and the two buttons
   * did nothing, with a tooltip still promising a keybind that was equally dead.
   *
   * ⚠ THEY STEP THROUGH WHAT THIS COLUMN IS SHOWING, SEARCH RESULTS INCLUDED. Stepping through
   * any other list — the old project-scoped one, or the unfiltered records behind a query — would
   * let the arrows and the rows disagree about which chat comes next, which is worse than the
   * buttons being inert.
   *
   * ⚠ AND IT WRAPS, which is the behaviour the titlebar's note assumes when it explains why
   * neither button ever disables.
   */
  const visibleSessions = createMemo(() =>
    search.query.value().trim() ? search.result.list() : (sessions.data.groups()[0]?.sessions ?? []),
  )

  const stepSession = (offset: number) => {
    const list = visibleSessions()
    if (list.length === 0) return

    const route = layout.route()
    const index = route.type === "session" ? list.findIndex((item) => item.session.id === route.sessionId) : -1
    const target =
      index === -1 ? list[offset > 0 ? 0 : list.length - 1] : list[(index + offset + list.length) % list.length]
    if (!target) return

    sessions.session.open(target.session)
  }

  command.register("sidebar", () => [
    {
      id: "sidebar.toggle",
      title: language.t("command.sidebar.toggle"),
      category: language.t("command.category.view"),
      keybind: "mod+b",
      onSelect: () => layout.sidebar.toggle(),
    },
    {
      id: "session.previous",
      title: language.t("command.session.previous"),
      category: language.t("command.category.session"),
      keybind: "alt+arrowup",
      onSelect: () => stepSession(-1),
    },
    {
      id: "session.next",
      title: language.t("command.session.next"),
      category: language.t("command.category.session"),
      keybind: "alt+arrowdown",
      onSelect: () => stepSession(1),
    },
  ])

  return (
    <aside
      data-component="app-sidebar"
      aria-label={language.t("sidebar.nav.projectsAndSessions")}
      aria-hidden={!opened()}
      inert={!opened()}
      class="relative z-10 flex min-w-0 flex-col overflow-hidden bg-v2-background-bg-deep"
      classList={{
        "shrink-0": true,
        "pointer-events-none": !opened(),
        "transition-[width] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
          !sizing.active(),
      }}
      /**
       * ⚠ WIDTH ZERO RATHER THAN `display: none`, so the column can slide. And the inline-start
       * safe-area padding lives here rather than on the layout's outer container, because the
       * titlebar is that container's sibling and computes its own inset for the traffic lights.
       */
      style={{
        width: opened() ? `${layout.sidebar.width()}px` : "0px",
        "padding-inline-start": "env(safe-area-inset-left, 0px)",
      }}
    >
      <div class="flex min-h-0 min-w-0 flex-1 flex-col gap-4 pl-2 pr-1 pt-2">
        {/*
         * ⚠ THE WHOLE SECTION IS GATED ON HAVING COURSES, HEADER INCLUDED. A "Courses" label over
         * nothing is worse than no label: the desktop refuses to open at all without an enrolment
         * (see the course gate), so an empty list here means the catalogue has not arrived yet.
         */}
        {listedCourses().length > 0 && (
          <AppSidebarSection
            id="courses"
            label={language.t("sidebar.courses")}
            collapseLabel={language.t("sidebar.courses.collapse")}
            expandLabel={language.t("sidebar.courses.expand")}
          >
            <AppSidebarCourses />
          </AppSidebarSection>
        )}

        <AppSidebarSection
          id="sessions"
          grow
          label={language.t("sidebar.sessions")}
          action={
            /* The `+` that used to live in the titlebar, next to the list it adds to. */
            <TooltipV2
              placement="bottom"
              value={
                <>
                  {language.t("command.session.new")}
                  <KeybindV2 keys={newTabTooltipKeybind(command)} variant="neutral" />
                </>
              }
            >
              <IconButtonV2
                data-action="app-sidebar-new-session"
                variant="ghost-muted"
                size="small"
                icon={<IconV2 name="edit" />}
                aria-label={language.t("command.session.new")}
                disabled={!sessions.session.canCreate()}
                onClick={sessions.session.create}
              />
            </TooltipV2>
          }
        >
          <AppSidebarSessions sessions={sessions} search={search} />
        </AppSidebarSection>

        <AppSidebarSection
          id="projects"
          label={language.t("home.projects")}
          collapseLabel={language.t("sidebar.projects.collapse")}
          expandLabel={language.t("sidebar.projects.expand")}
          action={
            <TooltipV2 placement="bottom" value={language.t("home.project.add")}>
              <IconButtonV2
                data-action="home-add-project"
                variant="ghost-muted"
                size="small"
                icon={<IconV2 name="folder-add-left" />}
                aria-label={language.t("home.project.add")}
                disabled={!home.server.focused()}
                onClick={() => {
                  const conn = home.server.focused()
                  if (conn) projects.project.choose(conn)
                }}
              />
            </TooltipV2>
          }
        >
          {/*
           * ⚠ `onWheel` IS A NO-OP HERE. On the home page that prop hands wheel events to the
           * page's outer scroller so the column does not trap them; this column IS the outermost
           * scroller on its side.
           */}
          <HomeProjectsListBody {...homeProjectsViewProps(projects, () => {})} />
        </AppSidebarSection>
      </div>

      {/*
       * ⚠ PINNED BELOW THE SECTIONS, OUTSIDE THE SCROLLING AREA. Who you are is not part of any
       * list and must not scroll away with one. Settings and Help live in its menu.
       */}
      <AppSidebarAccount />

      <ResizeHandle
        direction="horizontal"
        edge="end"
        size={layout.sidebar.width()}
        min={SIDEBAR_MIN_WIDTH}
        max={SIDEBAR_MAX_WIDTH}
        /**
         * ⚠ DRAGGING PAST THE MINIMUM CLOSES IT, which is the gesture people try first and the only
         * one that does not require finding the toggle. The threshold sits inside the minimum so
         * the intent has to be unambiguous.
         */
        collapseThreshold={SIDEBAR_MIN_WIDTH - 40}
        onResize={(next) => {
          sizing.start()
          layout.sidebar.resize(next)
        }}
        onCollapse={() => layout.sidebar.close()}
      />
    </aside>
  )
}
