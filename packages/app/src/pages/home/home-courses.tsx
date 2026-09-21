/**
 * THE READER'S COURSES, AS A SECTION OF THE HOME COLUMN.
 *
 * ⚠ IT SITS ABOVE PROJECTS BECAUSE IT IS THE COARSER AXIS. A student has two or three courses and
 * many repositories; the course is the thing they orient by first, and the project is where a
 * particular piece of that work happens to live.
 *
 * ⚠ SELF-CONTAINED RATHER THAN PROP-THREADED, UNLIKE `HomeProjectsView`. That view is pure because
 * its data comes from four controllers with real lifecycles — servers, health, drag ordering,
 * persistence. Courses are static fixtures plus one selection signal, so threading thirty props
 * through two adapters would add ceremony around nothing. If courses ever arrive from the gateway
 * with loading and error states, that is when this earns a controller.
 */

import { CourseAccent } from "@/components/course-accent"
import { For, Show } from "solid-js"
import { canStartSession, enrolledCourses } from "@/jolli/catalog"
import { HomeCourseSelection } from "@/jolli/home-selection"
import { useLayout } from "@/context/layout"
import { HomeProjectNavButton } from "./home-projects-view"

export function HomeCourses() {
  const layout = useLayout()
  const courses = () => enrolledCourses()
  const selected = () => HomeCourseSelection.courseId()

  /**
   * ⚠ SELECTING A COURSE DROPS THE PROJECT SELECTION, keeping the two axes mutually exclusive (see
   * `home-selection.ts`). The server key is preserved because it is not part of the same question —
   * it says which machine we are looking at, not which slice of its sessions.
   */
  const clearProject = () => layout.home.setSelection({ server: layout.home.selection().server })

  return (
    <Show when={courses().length > 0}>
      <div class="flex min-w-0 shrink-0 flex-col gap-1">
        {/* Same header geometry as the Projects label below it. */}
        <div class="flex h-7 min-w-0 shrink-0 items-center justify-between pl-1.5 pr-3">
          <div class="text-v2-text-text-muted [font-weight:530]">Courses</div>
        </div>
        <div class="flex min-w-0 flex-col pr-3">
          <For each={courses()}>
            {(course) => {
              const isSelected = () => selected() === course.id
              const startable = () => canStartSession(course.id)
              return (
                <HomeProjectNavButton
                  data-action="home-select-course"
                  data-selected={isSelected() ? "" : undefined}
                  aria-pressed={isSelected()}
                  title={`${course.code} · ${course.title}`}
                  onClick={() => {
                    // Clicking the selected course clears the filter, which is the only way back to
                    // "everything" without a second control.
                    const next = isSelected() ? undefined : course.id
                    HomeCourseSelection.select(next)
                    if (next) clearProject()
                  }}
                >
                  {/*
                   * ⚠ THE COURSE'S COLOUR, NOT ITS KIND. See `CourseAccent`: every course in this
                   * application is a code course, so a terminal glyph on every row said nothing,
                   * while the accent is what a student already uses to find CS 310 in a list.
                   */}
                  <CourseAccent accent={course.accent} />
                  <span class="min-w-0 flex-1 truncate">{course.code}</span>
                  {/*
                   * ⚠ THE UNREADY COURSE SAYS SO RATHER THAN BEING HIDDEN OR DISABLED. It is a real
                   * enrolment, and its sessions list is a legitimate place to stand even when no
                   * session can be started yet; the word is what stops a student reading the empty
                   * result as a fault of their own.
                   *
                   * ⚠ THE WORD IS NOT "DRAFT" ANY MORE, BECAUSE A DRAFT NEVER REACHES THIS LIST —
                   * `enrolledCourses` publishes-only. What survives to here and still cannot start
                   * is a published course with no assistant this application can run, and calling
                   * that "draft" would name the wrong absence.
                   */}
                  <Show when={!startable()}>
                    <span class="shrink-0 text-v2-text-text-faint">not ready</span>
                  </Show>
                </HomeProjectNavButton>
              )
            }}
          </For>
        </div>
        {/*
         * ⚠ NO DIVIDER HERE, AND THE FIRST VERSION HAD ONE. Upstream's rule places a divider between
         * a header row and the list BELONGING to it (a server and its projects), where it reads as
         * "these are its contents". Placed after a list instead, flush against the last row, it
         * renders as an underline on that row — CS 101 looked like it had been struck through. The
         * aside's own `gap-4` plus the "Projects" label already separate the two sections, which is
         * how every other pair of sections in this column is separated.
         */}
      </div>
    </Show>
  )
}
