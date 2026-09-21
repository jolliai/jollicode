import { createEffect, createMemo } from "solid-js"
import { useJolli } from "../context/jolli"
import { useTheme } from "../context/theme"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"

/**
 * WHICH COURSE THIS SESSION WILL BELONG TO.
 *
 * ⚠ ONLY COURSES THAT CAN ACTUALLY BE STARTED ARE LISTED, which is the opposite of the desktop
 * picker and a deliberate divergence. The desktop lists a draft and writes "your instructor hasn't
 * published this yet" beside it; a terminal list has no second column, no disabled styling and no
 * hover to carry that, so a row here can only be pressed and refused. Whatever cannot be chosen is
 * left out, and the one sentence explaining an empty list is said once by `DialogCourseGate` —
 * which keys on the same `startable` set, so the two can never disagree about what is showable.
 *
 * ⚠ ON A SESSION THAT ALREADY EXISTS THE WHOLE DIALOG IS `locked` RATHER THAN ABSENT. The binding
 * is fixed once the conversation starts — the server refuses to rewrite it — so there is nothing to
 * choose, but "which course am I in" is still a fair question and this is where a student asks it.
 *
 * ⚠ A LOCKED SESSION MAY NAME A COURSE THIS LIST NO LONGER CARRIES, because a term that ended does
 * not un-bind the transcripts written under it. The title reads it off the binding rather than off
 * the options for exactly that reason.
 */
export function DialogCourse() {
  const jolli = useJolli()
  const dialog = useDialog()
  const toast = useToast()
  const { theme } = useTheme()

  /**
   * ⚠ IT CLOSES ITSELF WHEN THE CREDENTIAL GOES, for the same reason `DialogCourseGate` does: a
   * dialog opened by an effect is not a view of the condition that opened it. Signing out leaves
   * this on screen offering courses that are no longer anybody's — and a moment later, once the
   * catalogue is refetched, offering none at all.
   */
  createEffect(() => {
    if (jolli.signedIn()) return
    dialog.clear()
  })

  const options = createMemo(() =>
    jolli.courses().map((course) => ({
      value: course.id,
      title: course.code,
      description: course.title,
    })),
  )

  return (
    <DialogSelect
      title={jolli.locked() ? "Course (fixed for this session)" : "Select course"}
      locked={jolli.locked()}
      current={jolli.course()?.id}
      options={options()}
      emptyView={
        <box paddingLeft={4} paddingRight={4}>
          <text fg={theme.textMuted}>
            {jolli.loaded() ? "You are not enrolled in any Jolli Code course yet." : "Loading your courses…"}
          </text>
        </box>
      }
      onSelect={(option) => {
        /**
         * ⚠ STILL CHECKED THOUGH THE LIST IS ALREADY FILTERED, because the two are separated by a
         * student's reading time. A term can end, or a professor can unpublish, between the frame
         * that drew this row and the keypress that chose it — the catalogue refreshes underneath.
         * Refusing out loud is cheaper than a session bound to a course that closed while it sat
         * on screen.
         */
        if (!jolli.canStart(option.value)) {
          toast.show({ message: "That course is no longer open.", variant: "warning", duration: 5000 })
          return
        }
        jolli.draft.setCourse(option.value)
        dialog.clear()
      }}
    />
  )
}
