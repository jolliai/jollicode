/**
 * THE STUDENT'S TODO ASSIGNMENTS: THE ONES WITH A TASK TO DO HERE, DUE SOONEST FIRST.
 *
 * ⚠ A ROW OPENS THE ASSIGNMENT, NOT A SESSION. An assignment has tasks, each with its own agent and,
 * once started, its own session; the dialog is where the student picks one, and where the tasks
 * worked on the web are listed so the assignment reads whole.
 *
 * ⚠ BETWEEN COURSES AND RECENT SESSIONS. Recent sessions takes the column's leftover height, so a
 * section below it would be pushed to the bottom edge; above it, the list is in view whenever the
 * sidebar is.
 *
 * ⚠ THE SIDECAR CHOSE THESE ROWS — see `/jolli/assignment`. Nothing here filters or sorts.
 */

import { For, Show } from "solid-js"
import type { Jolli } from "@opencode-ai/schema/jolli"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { DialogAssignment } from "@/components/dialog-assignment"
import { useLanguage } from "@/context/language"
import { APP_SIDEBAR_ROW_LABEL, AppSidebarRow } from "./app-sidebar-row"

export function AppSidebarAssignments(props: { assignments: readonly Jolli.AssignmentSummary[] }) {
  const language = useLanguage()
  const dialog = useDialog()

  /** "Due Oct 24": the day is what a student plans by; the dialog gives the time. */
  const due = (assignment: Jolli.AssignmentSummary) =>
    assignment.dueAt
      ? language.t("sidebar.assignment.due", {
          date: new Date(assignment.dueAt).toLocaleDateString(language.intl(), { month: "short", day: "numeric" }),
        })
      : undefined

  return (
    <div class="flex min-w-0 flex-col pr-1">
      <For each={props.assignments}>
        {(assignment) => (
          <AppSidebarRow
            type="button"
            data-action="app-sidebar-assignment"
            title={`${assignment.courseCode} · ${assignment.title}`}
            onClick={() =>
              void dialog.show(() => (
                <DialogAssignment
                  courseId={assignment.courseId}
                  assignmentId={assignment.id}
                  title={assignment.title}
                />
              ))
            }
          >
            <IconV2 name="check" size="small" class="shrink-0 text-v2-icon-icon-muted" />
            <span class={APP_SIDEBAR_ROW_LABEL}>{assignment.title}</span>
            <Show when={due(assignment)}>
              {(text) => <span class="shrink-0 text-v2-text-text-faint">{text()}</span>}
            </Show>
          </AppSidebarRow>
        )}
      </For>
    </div>
  )
}
