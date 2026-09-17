/**
 * WHICH COURSE AND WHOSE ASSISTANT THIS SESSION IS RUNNING UNDER, IN THE CHAT HEADER.
 *
 * ⚠ IT SITS BEFORE THE TITLE BECAUSE IT IS THE SCOPE THE TITLE IS INSIDE OF. A student with four
 * sessions open across two courses needs the answer to "which course am I in" without reading a
 * name they wrote themselves.
 *
 * ⚠ AND IT FITS INSIDE THE EXISTING 48px ROW, WHICH IS A CONSTRAINT RATHER THAN A PREFERENCE. The
 * header's height is hard-coded three times over in the timeline's virtual-scroll maths — as `64`
 * in `scrollMargin` and in each virtual row's `top`, and as `--sticky-accordion-top: 48px`. Anything
 * that grows this row silently mis-positions every message in a long session. Keep it one line.
 *
 * ⚠ IT IS A LABEL AND NEVER A CONTROL. The course and the assistant are fixed for the life of a
 * session; rendering them as something clickable would promise otherwise.
 */

import { CourseAccent } from "@/components/course-accent"
import { Show } from "solid-js"
import { useCourseSession } from "@/jolli/session-binding"

export function SessionCourseLabel() {
  const binding = useCourseSession()
  const course = () => binding.course()
  const assistant = () => binding.assistant()

  return (
    <Show when={course()}>
      {(value) => (
        <>
          <div
            data-slot="session-course-label"
            class="flex min-w-0 shrink-0 items-center gap-1.5 pl-2 text-[13px] font-[530] leading-4 tracking-[-0.04px] text-v2-text-text-faint"
            /* The full pairing in a tooltip, because the visible form truncates first on a narrow
               window and the assistant is the half that goes. */
            title={`${value().code} · ${value().title}${assistant() ? ` · ${assistant()!.name}` : ""}`}
          >
            {/* The course's own colour, the same bar the Home rail and the pickers use. */}
            <CourseAccent accent={value().accent} class="h-3.5 w-1" />
            <span class="shrink-0">{value().code}</span>
            <Show when={assistant()}>
              {(who) => (
                <>
                  <span class="text-v2-text-text-faint/60" aria-hidden="true">
                    ·
                  </span>
                  {/* Truncates before the course code does: which course you are in matters more
                      than which of its assistants when space runs out. */}
                  <span class="min-w-0 truncate">{who().name}</span>
                </>
              )}
            </Show>
          </div>
          <span
            data-slot="session-course-separator"
            class="-translate-y-[0.5px] shrink-0 pl-2 pr-1 text-[11px] font-medium text-v2-text-text-faint"
            aria-hidden="true"
          >
            /
          </span>
        </>
      )}
    </Show>
  )
}
