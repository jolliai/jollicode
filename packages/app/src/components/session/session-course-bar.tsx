/**
 * WHICH COURSE AND ASSISTANT THIS SESSION BELONGS TO, DIRECTLY ABOVE THE INPUT.
 *
 * ⚠ ONE MOUNT POINT COVERS BOTH SCREENS, WHICH IS WHY IT LIVES INSIDE THE COMPOSER. The draft
 * screen and a live session look nothing alike — one is a hero over `bg-deep`, the other a rounded
 * card over `bg-base` — but they render the same `PromptInputV2Composer`, so putting the bar in
 * there is the only placement that cannot drift between the two. It also means the binding is
 * described in the same spot on both, which is the point of moving it here.
 *
 * ⚠ THE SELECTORS MOVED UP FROM BELOW THE INPUT, NOT IN FROM A HEADER. Under the composer they sat
 * beneath the box and above the project row, reading as two unrelated settings floating under the
 * prompt; the course is the prior decision and now precedes it on screen.
 *
 * ⚠ AND THE PROJECT ROW HAS SINCE FOLLOWED THEM INTO THIS LINE, THROUGH `trailing`. Nothing is left
 * under the box: course, assistant, project, workspace and branch are one breadcrumb reading
 * coarse-to-fine, which is what they always were — two rows on opposite sides of the input made
 * "where does this session happen" look like two unrelated questions. A slot rather than an import
 * because each screen fills it differently: the draft passes the project picker, a live session a
 * read-only project and branch (its directory is fixed once it starts).
 */

import { children, Show, type JSX } from "solid-js"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { CourseAccent } from "@/components/course-accent"
import { assistantIconName } from "@/jolli/assistant-icon"
import { PromptAssistantSelector, PromptCourseSelector } from "@/components/prompt-course-selector"
import { useLanguage } from "@/context/language"
import { useCourseSession } from "@/jolli/session-binding"

export function SessionCourseBar(props: { onDone?: () => void; trailing?: JSX.Element }) {
  const language = useLanguage()
  const binding = useCourseSession()
  /** Resolved once so the `hidden` check below can consult it without building the nodes twice. */
  const trailing = children(() => props.trailing)

  /**
   * ⚠ NOTHING AT ALL WHEN A LIVE SESSION HAS NO COURSE, and that is the one branch worth arguing
   * about. The composer already renders a notice immediately above this — twelve pixels above —
   * saying there is no course and offering a new session, which is both the explanation and the way
   * out. A faint "No course" here would be the same sentence twice, one of which does nothing.
   *
   * ⚠ UNLESS SOMETHING WAS PASSED IN `trailing`, WHICH IS NOT A HYPOTHETICAL GUARD. This row is now
   * the only place either screen says which folder and branch it runs in; hiding it on a course-less
   * session would take that with it.
   */
  const hidden = () => binding.locked() && !binding.course() && !trailing()

  return (
    <Show when={!hidden()}>
      <div
        data-component="session-course-bar"
        class="flex min-h-7 min-w-0 items-center gap-1.5 overflow-hidden px-1 text-v2-text-text-faint"
        aria-label={language.t("prompt.course.bar.label")}
      >
        {/*
         * ⚠ THE LOCK IS READ-ONLY TEXT, NEVER A DISABLED DROPDOWN. Three reasons, and they compound:
         * the server refuses the write (`refuseRebindingAfterFirstMessage`), so a control that
         * looked usable would be lying; the client would not even attempt it, because
         * `draft.setCourse` writes `store.draft` and `current()` stops reading that the moment a
         * session id exists — the menu would open, accept a click and silently do nothing; and a
         * greyed-out dropdown advertises a permission that does not exist and never will, which
         * reads either as a bug or as something the student could earn.
         *
         * ⚠ `locked` IS STRICTER THAN THE SERVER'S RULE, DELIBERATELY. The server keys on
         * `Session.hasMessages`; this keys on the session existing at all. A CLI-created session
         * with no messages is therefore shown read-only even though the server would accept a
         * binding — which matches the notice above, whose answer to that state is "start a new
         * session" rather than "bind this one in place".
         */}
        <Show
          when={!binding.locked()}
          fallback={
            <Show when={binding.course()}>
              {(course) => (
                <>
                  <CourseAccent accent={course().accent} class="h-3.5 w-1" />
                  <span class="min-w-0 truncate text-v2-text-text-muted">{course().code}</span>
                  {/*
                   * ⚠ THE SAME SHAPE THE TUI PRINTS IN ITS COMPOSER FOOTER — `CS 310/Tutor`, course
                   * alone when there is no assistant. See `packages/tui/src/component/prompt`. One
                   * product, one way of saying this.
                   */}
                  <Show when={binding.assistant()}>
                    {(assistant) => (
                      <>
                        <span class="mx-0.5 shrink-0 select-none opacity-50">/</span>
                        {/*
                         * ⚠ THE PROFESSOR'S GLYPH, MATCHING THE SELECTOR THIS ROW MIRRORS. Every
                         * other segment here leads with a mark — the course's accent bar, the
                         * project's avatar, the branch's fork — and the assistant was the only one
                         * reading as bare text. The TUI footer prints `CS 310/Tutor` and still
                         * does; the note above is about the WORDS, and this adds none.
                         */}
                        <IconV2
                          name={assistantIconName(assistant().icon)}
                          size="small"
                          class="mr-1 shrink-0 text-v2-icon-icon-muted"
                        />
                        <span class="min-w-0 truncate">{assistant().name}</span>
                      </>
                    )}
                  </Show>
                </>
              )}
            </Show>
          }
        >
          <PromptCourseSelector onDone={props.onDone} />
          <PromptAssistantSelector onDone={props.onDone} />
        </Show>
        {/*
         * WHERE IT RUNS, AFTER WHAT IT IS. Project, workspace and branch when the caller has them —
         * see the `trailing` note in the header. They bring their own `/` dividers, so the join is
         * seamless with the course-to-assistant one immediately before it.
         */}
        {trailing()}
      </div>
    </Show>
  )
}
