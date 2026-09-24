/**
 * THE `/` ROUTE, WHICH IS NOW A PLACE TO STAND RATHER THAN A PLACE TO NAVIGATE FROM.
 *
 * ⚠ IT USED TO BE THE WHOLE NAVIGATION: a 280px column of courses and projects beside a 720px
 * column of sessions, with `mod+b` toggling in and out of it. All three lists are permanent in the
 * sidebar now, so repeating them here would be two copies of one thing, kept in step by nothing.
 *
 * ⚠ AND IT STILL HAS TO EXIST, WHICH IS WHY THIS IS NOT JUST DELETED. Three independent callers
 * navigate here: `context/tabs.tsx` when the last registry entry closes, when a server is removed
 * and when archived sessions are dropped; `app.tsx` when a draft id has no backing draft; and the
 * desktop renderer, whose `getLastActiveUrl` falls back to `"/"` on first launch. A route they can
 * all land on has to say something.
 *
 * ⚠ THE CARD FRAME IS KEPT ON PURPOSE. It is the same rounded, raised surface as
 * `SessionPanelFrame`, so arriving here reads as an empty session panel rather than as a different
 * kind of screen.
 */

import { Show } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { useHomeData } from "@/context/home-data"
import { useLanguage } from "@/context/language"
import { courseById } from "@/jolli/catalog"
import { HomeCourseSelection } from "@/jolli/home-selection"

export function NewHome() {
  const language = useLanguage()
  const { home, projects, sessions } = useHomeData()
  /**
   * ⚠ NAMED SO THE FILTER IS LEGIBLE FROM THE MAIN PANE. With a course selected the sidebar's
   * session list is narrowed to it, and an unexplained short list is the kind of thing a student
   * reads as lost work.
   */
  const course = () => courseById(HomeCourseSelection.courseId())
  const noProjects = () => home.project.list().length === 0

  return (
    /**
     * ⚠ THE `data-component` IS FOR AUTOMATION, AND IT REPLACES SOMETHING REAL. Specs used to wait
     * for `[data-component="home-session-search"]` to know this route had painted; that search box
     * is in the sidebar now and is on screen from the first frame of every route, so it can no
     * longer answer "am I home". This pane can.
     *
     * ⚠ FLUSH, FOR THE REASON `SessionPanelFrame` GIVES. Home and a session are the same pane to a
     * student switching between them; leaving this one inset and rounded while the other went flush
     * would make the window jump at every transition.
     */
    <div
      data-component="home-empty"
      class="min-h-0 flex-1 self-stretch overflow-hidden bg-v2-background-bg-base"
    >
      <div class="flex size-full flex-col items-center justify-center gap-4 px-6 text-center">
        <Show when={course()}>
          {(current) => (
            <div class="text-[13px] leading-[13px] tracking-[-0.04px] text-v2-text-text-muted [font-weight:530]">
              {current().code}
            </div>
          )}
        </Show>
        <div class="text-[13px] leading-[13px] tracking-[-0.04px] text-v2-text-text-base [font-weight:530]">
          {language.t("home.sessions.empty")}
        </div>
        {/*
         * ⚠ TWO DIFFERENT CALLS TO ACTION, BECAUSE THERE ARE TWO DIFFERENT REASONS TO BE HERE WITH
         * NOTHING. With no project there is nothing a session could run in, and offering "new
         * session" would be offering a button that returns without doing anything — the same trap
         * the course row's "+" avoids by disabling itself.
         */}
        <Show
          when={noProjects()}
          fallback={
            <>
              <p class="mb-1 max-w-80 text-[13px] leading-5 tracking-[-0.04px] text-v2-text-text-muted [font-weight:440]">
                {language.t("home.sessions.empty.description")}
              </p>
              <ButtonV2
                data-action="home-new-session"
                variant="neutral"
                size="normal"
                icon="edit"
                disabled={!sessions.session.canCreate()}
                onClick={sessions.session.create}
              >
                {language.t("command.session.new")}
              </ButtonV2>
            </>
          }
        >
          <p class="mb-1 max-w-80 text-[13px] leading-5 tracking-[-0.04px] text-v2-text-text-muted [font-weight:440]">
            {language.t("sidebar.empty.description")}
          </p>
          {/*
           * ⚠ ITS OWN ACTION NAME, BECAUSE THE SIDEBAR'S PROJECTS HEADER ALREADY OWNS
           * `home-add-project`. The two do the same thing and are on screen at the same time, so
           * one name across both is a locator that matches two elements — which Playwright's strict
           * mode reports as an ambiguous selector rather than picking one.
           */}
          <ButtonV2
            data-action="home-empty-add-project"
            variant="neutral"
            size="normal"
            icon="folder-add-left"
            disabled={!home.server.focused()}
            onClick={() => {
              const conn = home.server.focused()
              if (conn) projects.project.choose(conn)
            }}
          >
            {language.t("home.project.add")}
          </ButtonV2>
        </Show>
      </div>
    </div>
  )
}
