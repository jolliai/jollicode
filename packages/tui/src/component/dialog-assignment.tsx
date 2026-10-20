/**
 * `/assignment`: THE ASSIGNMENTS TO DO, THEN ONE ASSIGNMENT'S TASKS — WHERE A TASK'S SESSION IS
 * STARTED, CONTINUED, AND THE ASSIGNMENT TURNED IN.
 *
 * ⚠ TWO LEVELS, LIKE THE DESKTOP'S SIDEBAR AND DIALOG. The list is the sidecar's — open, not turned in,
 * with a task worked in Jolli Code, due soonest first — and an assignment's tasks are all listed, the
 * web ones included, so it reads whole; a web task only says where it is done.
 *
 * ⚠ A TASK'S SESSION IS CONTINUED BEFORE IT IS STARTED AGAIN, AND ONLY HERE. A terminal works in the
 * folder it was launched in, so a session of the task that lives in another folder is pointed to rather
 * than opened, and nothing new is started beside it: a task takes one session handed in.
 *
 * ⚠ STARTING GOES HOME. The task's session is a new one; asked from inside another session, the draft is
 * staged on the home screen, whose composer then offers Start.
 */

import type { Jolli } from "@opencode-ai/schema/jolli"
import { taskDraftOf, toRead } from "@opencode-ai/core/jolli/assignment"
import { createMemo, createResource } from "solid-js"
import { useJolli } from "../context/jolli"
import { useRoute } from "../context/route"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useTheme } from "../context/theme"
import { DialogConfirm } from "../ui/dialog-confirm"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"

/** "Oct 24, 11:59 PM", in the terminal's own locale. */
function when(instant: string) {
  return new Date(instant).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

export function DialogAssignments() {
  const sdk = useSDK()
  const dialog = useDialog()
  const { theme } = useTheme()
  const [list] = createResource(async () => {
    const response = await sdk.client.jolli.assignments({ fresh: "true" }).catch(() => undefined)
    return response?.data
  })
  const options = createMemo(() =>
    (list()?.assignments ?? []).map((assignment) => ({
      value: assignment,
      title: assignment.title,
      description: [
        assignment.courseCode,
        assignment.dueAt ? `due ${when(assignment.dueAt)}` : undefined,
        `${assignment.tasksHandedIn}/${assignment.tasksTotal} tasks handed in`,
      ]
        .filter(Boolean)
        .join(" · "),
    })),
  )
  return (
    <DialogSelect
      title="TODO assignments"
      options={options()}
      emptyView={
        <box paddingLeft={4} paddingRight={4}>
          <text fg={theme.textMuted}>
            {list.loading
              ? "Loading your assignments…"
              : list()?.status === "ok"
                ? "Nothing to do in Jolli Code right now."
                : "Couldn't reach Jolli. Try /assignment again in a moment."}
          </text>
        </box>
      }
      onSelect={(option) => {
        dialog.replace(() => <DialogAssignmentTasks courseId={option.value.courseId} assignmentId={option.value.id} />)
      }}
    />
  )
}

type TaskChoice = { kind: "task"; task: Jolli.AssignmentTask } | { kind: "turn-in" }

export function DialogAssignmentTasks(props: { courseId: string; assignmentId: string }) {
  const sdk = useSDK()
  const sync = useSync()
  const jolli = useJolli()
  const route = useRoute()
  const dialog = useDialog()
  const toast = useToast()
  const { theme } = useTheme()
  const [read] = createResource(async () =>
    toRead(
      (
        await sdk.client.jolli
          .assignment({ courseId: props.courseId, assignmentId: props.assignmentId, fresh: "true" })
          .catch(() => undefined)
      )?.data,
    ),
  )
  const assignment = () => {
    const answer = read()
    return answer?.status === "ok" ? answer.assignment : undefined
  }
  const failure = () => {
    const answer = read()
    return answer?.status === "refused" && answer.message
      ? answer.message
      : "Couldn't reach Jolli. Try /assignment again in a moment."
  }
  /** The folder this terminal works in: where a task's session can be continued, and a new one starts. */
  const here = () => sync.path.directory || sdk.directory

  const status = (task: Jolli.AssignmentTask) => {
    if (task.handedInAt) return `Handed in ${when(task.handedInAt)}`
    if (!task.owed) return "No longer needed"
    if (task.place === "web") return "Do this task on the web"
    if (task.local) return "In progress"
    if (task.elsewhere) return "Started on another computer"
    return "Not started"
  }

  const options = createMemo(() => {
    const found = assignment()
    if (!found) return []
    const tasks = found.tasks.map((task) => ({
      value: { kind: "task", task } as TaskChoice,
      title: `${task.title} · ${task.name}`,
      description: status(task),
      disabled: task.place === "web" || (!task.owed && !task.handedInAt),
    }))
    const turnIn = found.readyToTurnIn
      ? [{ value: { kind: "turn-in" } as TaskChoice, title: "Turn in", description: "Every task is handed in" }]
      : []
    return [...tasks, ...turnIn]
  })

  const choose = async (choice: TaskChoice) => {
    const found = assignment()
    if (!found) return
    if (choice.kind === "turn-in") return turnIn(found)
    const task = choice.task
    if (task.place === "web") return
    if (task.local) {
      if (task.local.directory !== here()) {
        toast.show({
          message: `This task's session is in ${task.local.directory}. Open jollicode there to continue it.`,
          variant: "warning",
          duration: 8000,
        })
        return
      }
      dialog.clear()
      route.navigate({ type: "session", sessionID: task.local.sessionID })
      return
    }
    if (task.handedInAt) {
      toast.show({
        message: "This task is handed in. Ask your teacher to reopen it to hand in again.",
        variant: "info",
      })
      return
    }
    const draft = taskDraftOf(found, task)
    if (!draft) return
    dialog.clear()
    if (route.data.type !== "home") route.navigate({ type: "home" })
    jolli.draft.setTask(draft)
  }

  /**
   * ⚠ CONFIRMED HERE, NOT THROUGH A PERMISSION PROMPT. The student chose Turn in themselves; the
   * confirmation says what it means, and their answer is the approval.
   */
  const turnIn = async (found: Jolli.Assignment) => {
    const ok = await DialogConfirm.show(
      dialog,
      `Turn in ${found.title}?`,
      `${found.authorName ?? "Your teacher"} can review it once it's turned in. You can't hand in more unless they reopen it.`,
      "Turn in",
    )
    if (!ok) return
    const answer = toRead(
      (
        await sdk.client.jolli
          .turnIn({ courseId: props.courseId, assignmentId: props.assignmentId })
          .catch(() => undefined)
      )?.data,
    )
    if (answer.status === "ok") {
      toast.show({ message: `Turned in ${found.title}.`, variant: "success" })
      return
    }
    toast.show({
      message: answer.status === "refused" && answer.message ? answer.message : "Couldn't reach Jolli. Try again.",
      variant: "warning",
      duration: 8000,
    })
  }

  return (
    <DialogSelect
      title={assignment()?.title ?? "Assignment"}
      options={options()}
      emptyView={
        <box paddingLeft={4} paddingRight={4}>
          <text fg={theme.textMuted}>{read.loading ? "Loading the assignment…" : failure()}</text>
        </box>
      }
      onSelect={(option) => void choose(option.value)}
    />
  )
}
