/**
 * THE READER'S COURSES, AS THE SIDEBAR'S FIRST SECTION — A TREE, NOT A LIST OF FILTERS.
 *
 * ⚠ EACH COURSE IS A FOLDER AND ITS SESSIONS HANG UNDER IT. The flat "Sessions" section below is
 * still the whole recent list, in time order, with the search; this section answers the other
 * question — "what have I done for CS 201" — without making the reader set a filter and read the
 * answer somewhere else on screen. The same session legitimately appears in both, exactly as a chat
 * appears under its project AND under "Recent".
 *
 * ⚠ THE DISCLOSURE IS ITS OWN BUTTON BESIDE THE ROW, NOT THE ROW ITSELF. Expanding a course and
 * selecting one are different questions — the row still drives `HomeCourseSelection`, which the
 * session list and the home header both read — and a row that did both would make "show me what is
 * in here" silently retarget every other surface. Separate controls, and selecting also opens the
 * folder because that is never the wrong thing to do.
 *
 * ⚠ IT SITS ABOVE SESSIONS AND PROJECTS BECAUSE IT IS THE COARSEST AXIS. A student has two or three
 * courses, a few dozen sessions and many repositories; the course is what they orient by first.
 *
 * ⚠ IT LIVED IN `pages/home/home-courses.tsx` UNTIL THE SIDEBAR BECAME PERMANENT, and it moved
 * because the home page stopped being its only reader and then stopped being a reader at all. The
 * wrapper it used to have — a "Courses" header and the column's gutter — is now
 * `AppSidebarSection`'s job, so what is left is only the rows.
 *
 * ⚠ SELF-CONTAINED RATHER THAN PROP-THREADED, UNLIKE THE PROJECT ROWS. Those take thirty props
 * because their data comes from controllers with real lifecycles — servers, health, drag ordering,
 * persistence. Courses arrive through the module-level store in `jolli/catalog.ts`, which already
 * de-dupes its load and already carries its own "has the answer arrived" flag.
 */

import { createMemo, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { CourseAccent } from "@/components/course-accent"
import { useHomeData } from "@/context/home-data"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { canStartSession, listedCourses } from "@/jolli/catalog"
import { CourseIntent, courseIntentRouteKey } from "@/jolli/course-intent"
import { HomeCourseSelection } from "@/jolli/home-selection"
import { createInlineEditorController } from "@/pages/layout/inline-editor"
import type { HomeSessionRecord } from "@/pages/home/home-sessions-controller"
import { APP_SIDEBAR_ROW_LABEL, AppSidebarRow } from "./app-sidebar-row"
import { AppSidebarSessionRow } from "./app-sidebar-sessions"

/**
 * ⚠ THE TREE IS CAPPED IN HEIGHT AND SCROLLS INSIDE THAT CAP. This section is `shrink-0` in the
 * column, so several courses expanded at once would not overflow — they would squeeze the Sessions
 * section below to nothing, taking the search box with it. This bounds the section however many
 * folders are open; `COURSE_SESSION_LIMIT` bounds each folder on its own.
 */
const COURSE_TREE_MAX_HEIGHT = "max-h-[40vh]"

/**
 * FIVE SESSIONS PER FOLDER, NEWEST FIRST — A PREVIEW OF THE COURSE, NOT ITS ARCHIVE.
 *
 * ⚠ AN UNCAPPED FOLDER BECOMES THE FLAT LIST IT SITS ABOVE. A term's work under one heading pushes
 * every other course off the screen, so the reader scrolls past the very rows they opened this
 * section to orient by — and the two sections end up answering the same question, one of them badly.
 *
 * ⚠ THE REST ARE ONE CLICK AWAY RATHER THAN LOST, which is what makes a count cap honest here.
 * Selecting the course row points `HomeCourseSelection` at it, and the Sessions section below then
 * lists that course's sessions up to `HOME_SESSION_LIMIT` — the "show me everything for CS 201" path
 * this tree shortcuts rather than replaces.
 */
const COURSE_SESSION_LIMIT = 5

export function AppSidebarCourses() {
  const language = useLanguage()
  const layout = useLayout()
  const { sessions } = useHomeData()
  /**
   * ⚠ NOT EVERY ENROLMENT — see `listedCourses`. A course that cannot be started is a row that
   * cannot be clicked into a session, and a column of those is what this section looked like once
   * the gateway started serving drafts, ended terms and archives alongside the live courses. They
   * come back the moment none of them can be started, which is the one case where the row's
   * "Not ready" is the only thing that can explain an empty screen.
   */
  const courses = () => listedCourses()
  /**
   * ⚠ THE HIGHLIGHT IS THE FILTER'S AND NOTHING ELSE'S. It used to fall back to the open session's
   * course, which meant opening a chat lit up its course row as well — two stacked filled rows
   * saying one thing, and the student had selected only one of them. A course row is a toggle
   * (`aria-pressed`); its fill should mean "this is the filter you set", never "this is where the
   * thing you opened lives". The session row already says the latter, and says it alone.
   *
   * ⚠ WITH A FILTER ACTIVE THE TWO STILL COINCIDE, and that is correct rather than a leftover.
   * `AppSidebar` re-points an ALREADY ACTIVE filter at the course of a session you open, so both
   * rows fill — but the filter is a thing the student turned on, and its row is showing its own
   * state. With no filter, which is the default, nothing follows the chat any more.
   */
  const highlighted = () => HomeCourseSelection.courseId()
  const selected = highlighted
  /** Whether there is a project to run a session in at all — see the `disabled` note on the "+". */
  const canCreate = () => sessions.session.canCreate()

  /**
   * THE CHILDREN OF EACH FOLDER, OFF THE *UNFILTERED* RECORDS.
   *
   * ⚠ `searchRecords` RATHER THAN `records`, AND THE DIFFERENCE IS THE WHOLE POINT. `records` has
   * already had `HomeCourseSelection` applied to it, so building the tree from it would empty every
   * folder except the selected one the moment anybody clicked a course — a tree that collapses to
   * one branch when you touch it. `searchRecords` is the same list before that filter, already
   * sorted newest-first and already capped upstream.
   *
   * ⚠ SESSIONS WITH NO BINDING ARE SKIPPED RATHER THAN BUCKETED. `record.course` is optional by
   * design — CLI sessions and anything predating the binding have none — and they are not missing
   * from the sidebar: the Sessions section below lists every one of them.
   *
   * ⚠ THE CAP IS TAKEN WHILE BUCKETING RATHER THAN SLICED OFF AFTERWARDS, which is both cheaper and
   * the reason it is correct: the source arrives sorted on `compareSessionTime`, so the first
   * `COURSE_SESSION_LIMIT` records to reach a bucket ARE that course's most recent. Slicing at the
   * point of use would also hand `<For>` a freshly allocated array on every read, and `<For>` keys
   * by reference.
   */
  const byCourse = createMemo(() => {
    const map = new Map<string, HomeSessionRecord[]>()
    for (const record of sessions.data.searchRecords()) {
      const id = record.course?.id
      if (!id) continue
      const bucket = map.get(id)
      if (!bucket) map.set(id, [record])
      else if (bucket.length < COURSE_SESSION_LIMIT) bucket.push(record)
    }
    return map
  })

  /**
   * ⚠ OPEN UNLESS SAID OTHERWISE, WHICH IS WHY THE STORE HOLDS ONLY THE EXCEPTIONS. A folder whose
   * contents are hidden by default is a folder most readers never open, and with two or three
   * enrolments there is nothing to protect them from. The cap above is what keeps that affordable.
   *
   * ⚠ AND IT IS LOCAL RATHER THAN IN `layout.sidebar`, unlike the section collapse. That one is
   * persisted because a collapsed section is a lasting statement about a whole part of the column;
   * which folders you had open is scratch state, and courses come and go between terms.
   */
  const [open, setOpen] = createStore<Record<string, boolean>>({})
  const isOpen = (id: string) => open[id] ?? true

  /**
   * ⚠ ONE EDITOR AND ONE OPEN MENU FOR THIS TREE, HELD HERE — the same invariant `AppSidebarSessions`
   * keeps for the flat list, and deliberately a SEPARATE instance rather than one shared between the
   * two. Sharing would mean renaming a session in the tree also opened a field on its twin in the
   * list below, which is one rename in two places; two controllers make each list behave like the
   * only list, which is how each of them is read.
   */
  const editor = createInlineEditorController()
  const [menu, setMenu] = createStore({ open: undefined as string | undefined })
  const rowProps = {
    editor,
    menuOpen: (id: string) => menu.open === id,
    onSetMenuOpen: (id: string, value: boolean) => setMenu("open", value ? id : undefined),
  }

  /**
   * ⚠ SELECTING A COURSE DROPS THE PROJECT SELECTION, keeping the two axes mutually exclusive (see
   * `jolli/home-selection.ts`). The server key is preserved because it is not part of the same
   * question — it says which machine we are looking at, not which slice of its sessions.
   */
  const clearProject = () => layout.home.setSelection({ server: layout.home.selection().server })

  return (
    <ScrollView class={`min-w-0 ${COURSE_TREE_MAX_HEIGHT}`}>
      <div class="flex min-w-0 flex-col pr-1">
        <For each={courses()}>
          {(course) => {
            const isSelected = () => selected() === course.id
            const isHighlighted = () => highlighted() === course.id
            const startable = () => canStartSession(course.id)
            const children = () => byCourse().get(course.id) ?? []
            const expanded = () => isOpen(course.id)
            return (
              <div class="flex min-w-0 flex-col">
                <div class="group/course relative flex h-7 min-w-0 items-center rounded-[6px]">
                  {/*
                   * THE DISCLOSURE, AS A SIBLING OF THE ROW RATHER THAN A CHILD OF IT. The row is a
                   * `<button>`; nesting one inside it is invalid markup and the click would run both
                   * handlers, so you would expand the folder AND retarget the session filter. Same
                   * arrangement as the "+" at the other end of the row.
                   *
                   * ⚠ IT IS RENDERED EVEN FOR AN EMPTY COURSE, and that is not an oversight. A
                   * chevron that disappears on some rows breaks the left edge of the tree, and an
                   * empty folder that can be opened is how the reader finds out it is empty — the
                   * line inside says so.
                   *
                   * ⚠ THE ACCESSIBLE NAME IS THE COURSE CODE AND THE STATE IS `aria-expanded`, which
                   * is the whole label a disclosure needs. The alternative — "Expand {{code}}" —
                   * would be a new string in sixty-one locales to say what the attribute already
                   * says in the reader's own words.
                   */}
                  <button
                    type="button"
                    data-action="app-sidebar-course-toggle"
                    aria-expanded={expanded()}
                    aria-label={course.code}
                    class={`
                      flex size-5 shrink-0 cursor-default items-center justify-center rounded-[4px]
                      text-v2-icon-icon-muted hover:bg-v2-overlay-simple-overlay-hover
                      focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none
                    `}
                    onClick={() => setOpen(course.id, !expanded())}
                  >
                    <IconV2
                      name="chevron-down"
                      size="small"
                      class="shrink-0 transition-transform duration-150 ease-in-out"
                      style={{ transform: `rotate(${expanded() ? 0 : -90}deg)` }}
                    />
                  </button>
                  <AppSidebarRow
                    type="button"
                    data-action="home-select-course"
                    data-selected={isHighlighted() ? "" : undefined}
                    aria-pressed={isSelected()}
                    title={`${course.code} · ${course.title}`}
                    classList={{ "pr-8": startable() }}
                    onClick={() => {
                      // Clicking the selected course clears the filter, which is the only way back to
                      // "everything" without a second control.
                      const next = isSelected() ? undefined : course.id
                      HomeCourseSelection.select(next)
                      if (next) {
                        clearProject()
                        // Opening what you just pointed at. Never the wrong thing to do, and it
                        // keeps "selected" from ever meaning a folder you cannot see the inside of.
                        setOpen(course.id, true)
                      }
                    }}
                  >
                    {/*
                     * ⚠ THE COURSE'S COLOUR, NOT ITS KIND. See `CourseAccent`: every course in this
                     * application is a code course, so a terminal glyph on every row said nothing,
                     * while the accent is what a student already uses to find CS 310 in a list.
                     */}
                    <CourseAccent accent={course.accent} />
                    <span class={APP_SIDEBAR_ROW_LABEL}>{course.code}</span>
                    {/*
                     * ⚠ AN UNREADY ROW REACHES THIS LIST ONLY WHEN NOTHING ELSE WOULD — see
                     * `listedCourses`. It is a real enrolment and its session list is a legitimate place
                     * to stand, so when it is all the student has, saying so beats an empty column that
                     * they would read as a fault of their own. Beside a course they CAN open it is
                     * noise, which is why it is filtered there.
                     *
                     * ⚠ THE WORD IS "NOT READY" BECAUSE IT HAS TO COVER FIVE DIFFERENT ABSENCES. A row
                     * here may be unpublished, not yet open, ended, archived, or without an assistant,
                     * and one word has to be honest about all five.
                     *
                     * ⚠ THE SPECIFIC REASON LIVES IN THE PICKER, NOT HERE. `prompt-course-selector` has
                     * room for a sentence per refusal (`Lookup.blockedReason`); this row is a 28px
                     * filter in a narrow column and has room for two words.
                     */}
                    <Show when={!startable()}>
                      <span class="shrink-0 text-v2-text-text-faint">{language.t("sidebar.course.notReady")}</span>
                    </Show>
                  </AppSidebarRow>
                  {/*
                   * START A SESSION IN THIS COURSE, WITHOUT GOING TO A PICKER FIRST.
                   *
                   * ⚠ A SIBLING OF THE ROW, NOT A CHILD OF IT. The row is a `<button>`; a button inside
                   * a button is invalid markup and the click would run both handlers — you would get a
                   * new session AND a filter change. Absolute positioning puts it over the row's right
                   * edge without putting it inside the row's element, which is the same arrangement the
                   * project rows use for their menu.
                   *
                   * ⚠ ONLY ON STARTABLE COURSES. An unready course's trailing slot already holds the
                   * words saying so, and a "+" there would offer something the server refuses.
                   *
                   * ⚠ `hover-reveal` RATHER THAN A CONDITIONAL MOUNT. It is `opacity` plus
                   * `transition-opacity`, and it forces `opacity: 1` under `@media (hover: none)` so a
                   * touch user is not left with an invisible control. `focus-within` is what makes it
                   * reachable by keyboard: a hover-only affordance does not exist for anyone tabbing.
                   */}
                  <Show when={startable()}>
                    <TooltipV2
                      placement="bottom"
                      class={`
                        hover-reveal absolute right-0.5 top-1/2 flex -translate-y-1/2 items-center
                        group-hover/course:opacity-100 focus-within:opacity-100
                      `}
                      value={
                        canCreate()
                          ? language.t("sidebar.course.newSession", { code: course.code })
                          : language.t("sidebar.course.newSession.noProject")
                      }
                    >
                      {/*
                       * ⚠ DISABLED AND EXPLAINED, RATHER THAN HIDDEN OR SILENTLY INERT.
                       * `home.project.openNewSession` returns without doing anything when there is no
                       * project to run in, so an always-enabled button would be one that does nothing
                       * and says nothing. Hiding it instead would be wrong the other way: adding a
                       * project is something the student can do, and the Projects section right below
                       * is where they do it. This follows `prompt-course-selector`'s rule — a refusal is
                       * shown with its reason, not removed.
                       *
                       * ⚠ THE TOOLTIP STILL WORKS WHILE DISABLED, because `TooltipV2` renders its
                       * trigger as a wrapping `div` and listens there rather than on this button.
                       */}
                      <IconButtonV2
                        data-action="home-course-new-session"
                        variant="ghost-muted"
                        size="small"
                        icon={<IconV2 name="plus" />}
                        aria-label={language.t("sidebar.course.newSession", { code: course.code })}
                        disabled={!canCreate()}
                        onClick={() => {
                          /**
                           * ⚠ THE REQUEST IS PUBLISHED BEFORE THE NAVIGATION, because the context that
                           * consumes it is created BY that navigation — the draft route mounts
                           * `CourseSessionProvider`, which reads `CourseIntent` in its pre-selection
                           * effect. See `jolli/course-intent.ts` for why this cannot be a direct call.
                           *
                           * ⚠ AND IT CARRIES THE SCREEN IT WAS ASKED FROM, so the request belongs to the
                           * session this click is about to create rather than to every new session after
                           * it. Abandoning that draft is how it ends when no session is ever started.
                           */
                          CourseIntent.request(course.id, courseIntentRouteKey(layout.route()))
                          sessions.session.create()
                        }}
                      />
                    </TooltipV2>
                  </Show>
                </div>
                {/*
                 * THE FOLDER'S CONTENTS.
                 *
                 * ⚠ UNMOUNTED WHEN CLOSED RATHER THAN HIDDEN, which is the rule `AppSidebarSection`
                 * already follows for the same reason: every one of these rows holds live avatar
                 * state (`useSessionTabAvatarState`), and a hidden row is still a tab stop.
                 *
                 * ⚠ THE INDENT IS ON THE WRAPPER, NOT ON EACH ROW'S PADDING. `AppSidebarRow` is
                 * `w-full`, so insetting the block insets the rows' hover highlight with them and
                 * the nesting stays legible while a child is highlighted — padding inside the button
                 * would have left the highlight starting under the chevron.
                 *
                 * ⚠ AND AN EMPTY FOLDER SAYS SO IN THE WORDS THE SESSION LIST ALREADY USES. A course
                 * a student has never opened a session in is the normal state at the start of term,
                 * not an error, and `home.sessions.empty` is the sentence this application already
                 * says for "this list is legitimately empty".
                 */}
                <Show when={expanded()}>
                  <div class="flex min-w-0 flex-col pl-5">
                    <For
                      each={children()}
                      fallback={
                        <div class="flex h-7 min-w-0 items-center px-1.5 text-v2-text-text-faint">
                          {language.t("home.sessions.empty")}
                        </div>
                      }
                    >
                      {(record) => <AppSidebarSessionRow {...rowProps} sessions={sessions} record={record} />}
                    </For>
                  </div>
                </Show>
              </div>
            )
          }}
        </For>
      </div>
    </ScrollView>
  )
}
