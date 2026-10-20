/**
 * ONE ASSIGNMENT, AS A STUDENT WORKS IT FROM JOLLI CODE: ITS TASKS, AND WHAT EACH ONE LETS THEM DO.
 *
 * ⚠ EVERY TASK IS LISTED, NOT ONLY THE ONES WORKED HERE. A task worked on the web says so and offers
 * nothing; leaving it out would make the assignment look smaller than it is, and the turn-in below
 * waits on it all the same.
 *
 * ⚠ A JOLLI CODE TASK IS CONTINUED BEFORE IT IS STARTED AGAIN. A task takes one session handed in, so
 * when one of its sessions is on this machine the dialog opens that one, in its own folder; Start is
 * offered only when none is here — on a new computer, or after the student deleted it.
 *
 * ⚠ TURNING IN IS CONFIRMED HERE, NOT THROUGH THE PERMISSION DOCK. That dock is how a student approves
 * what an agent asks to do; here the student pressed the button themselves, so the confirmation lists
 * what is turned in and the click is the approval.
 *
 * ⚠ READ FRESH WHEN IT OPENS. The student opens this to act, and the sidecar's minute-old copy may not
 * know a task was handed in on the web a moment ago.
 */

import { createResource, createSignal, For, Match, Show, Switch } from "solid-js"
import type { Jolli } from "@opencode-ai/schema/jolli"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { useHomeData } from "@/context/home-data"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useServerSDK } from "@/context/server-sdk"
import { taskDraftOf } from "@opencode-ai/core/jolli/assignment"
import { AssignmentIntent } from "@/jolli/assignment-intent"
import { readAssignment, turnIn, useTaskTitle, type AssignmentRead } from "@/jolli/assignments"
import { courseIntentRouteKey } from "@/jolli/course-intent"

export function DialogAssignment(props: { courseId: string; assignmentId: string; title: string }) {
  const language = useLanguage()
  const dialog = useDialog()
  const layout = useLayout()
  const serverSDK = useServerSDK()
  const { sessions } = useHomeData()
  const [attempt, setAttempt] = createSignal(0)
  const [answer, setAnswer] = createSignal<AssignmentRead>()
  const [read] = createResource(attempt, () =>
    readAssignment(serverSDK().client, props.courseId, props.assignmentId, true),
  )
  /** The latest word on the assignment: a turn-in's answer once there is one, else the read's. */
  const current = () => answer() ?? read.latest ?? { status: "loading" as const }
  const loaded = () => {
    const now = current()
    return now.status === "ok" ? now.assignment : undefined
  }
  const failure = () => {
    const now = current()
    if (now.status === "refused" && now.message) return now.message
    return now.status === "refused" || now.status === "unreachable"
      ? language.t("dialog.assignment.unreachable")
      : undefined
  }
  const [confirming, setConfirming] = createSignal(false)
  const [turning, setTurning] = createSignal(false)
  const [turnInRefusal, setTurnInRefusal] = createSignal<string>()

  const when = (instant: string) =>
    new Date(instant).toLocaleString(language.intl(), {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })

  const taskTitle = useTaskTitle()

  /** Begin a new session for the task: a draft bound to it, in the project the student works in. */
  const start = (assignment: Jolli.Assignment, task: Jolli.AssignmentTask, index: number) => {
    const draft = taskDraftOf(assignment, task, taskTitle(index))
    if (!draft) return
    AssignmentIntent.request(draft, courseIntentRouteKey(layout.route()))
    dialog.close()
    sessions.session.create()
  }

  /**
   * Open the task's session that is on this machine, where it lives.
   *
   * ⚠ THE RECENT LIST'S RECORD WHEN IT HOLDS ONE, A STAND-IN OTHERWISE. That list is capped; a session
   * opened weeks ago is past it, and opening needs only its id and folder.
   */
  const resume = (local: Jolli.AssignmentTaskSession) => {
    const record = sessions.data.searchRecords().find((item) => item.session.id === local.sessionID)
    dialog.close()
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- `open` reads only the id, the folder and the project id.
    sessions.session.open(record?.session ?? ({ id: local.sessionID, directory: local.directory } as Session))
  }

  const confirmTurnIn = async () => {
    setTurning(true)
    setTurnInRefusal(undefined)
    const result = await turnIn(serverSDK().client, props.courseId, props.assignmentId).finally(() => setTurning(false))
    if (result.status === "ok") {
      setAnswer(result)
      setConfirming(false)
      return
    }
    setTurnInRefusal(
      result.status === "refused" && result.message ? result.message : language.t("dialog.assignment.unreachable"),
    )
  }

  return (
    <Dialog fit>
      <DialogHeader>
        <DialogTitle>{props.title}</DialogTitle>
      </DialogHeader>
      <DialogBody class="flex max-h-[min(560px,calc(100vh-160px))] w-[min(560px,calc(100vw-48px))] flex-col gap-4 overflow-y-auto px-4 pt-2 pb-2">
        <Switch>
          <Match when={current().status === "loading"}>
            <p data-component="dialog-assignment-loading" class="text-[13px] text-v2-text-text-muted">
              {language.t("dialog.assignment.loading")}
            </p>
          </Match>
          <Match when={failure()}>
            <div class="flex items-center gap-3">
              <p data-component="dialog-assignment-failed" class="min-w-0 flex-1 text-[13px] text-v2-text-text-muted">
                {failure()}
              </p>
              <ButtonV2 variant="neutral" size="normal" onClick={() => setAttempt((count) => count + 1)}>
                {language.t("dialog.assignment.retry")}
              </ButtonV2>
            </div>
          </Match>
          <Match when={loaded()}>
            {(assignment) => (
              <>
                <div class="flex flex-col gap-1 text-[13px] leading-5">
                  <span class="text-v2-text-text-muted">
                    {[
                      assignment().courseCode,
                      assignment().dueAt
                        ? language.t("sidebar.assignment.due", { date: when(assignment().dueAt!) })
                        : language.t("dialog.assignment.noDue"),
                      ...(assignment().stopAtDue && assignment().dueAt
                        ? [language.t("dialog.assignment.stopsAtDue")]
                        : []),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                  <Show when={assignment().description.trim()}>
                    <p class="whitespace-pre-line text-v2-text-text-base">{assignment().description}</p>
                  </Show>
                </div>
                <ul data-component="dialog-assignment-tasks" class="flex flex-col gap-2">
                  <For each={assignment().tasks}>
                    {(task, index) => (
                      <li
                        data-component="dialog-assignment-task"
                        data-part={task.partId}
                        class="flex items-center gap-3 rounded-lg bg-v2-background-bg-base px-3 py-2.5 shadow-[var(--v2-elevation-raised)]"
                      >
                        <div class="flex min-w-0 flex-1 flex-col">
                          <span class="truncate text-[13px] text-v2-text-text-base">
                            {taskTitle(index())} · {task.name}
                          </span>
                          <span class="truncate text-[12px] text-v2-text-text-muted">
                            <Switch fallback={language.t("dialog.assignment.task.notStarted")}>
                              <Match when={task.handedInAt}>
                                {(at) => language.t("dialog.assignment.task.handedIn", { date: when(at()) })}
                              </Match>
                              <Match when={!task.owed}>{language.t("dialog.assignment.task.notOwed")}</Match>
                              <Match when={task.place === "web"}>{language.t("dialog.assignment.task.web")}</Match>
                              <Match when={task.local}>{language.t("dialog.assignment.task.inProgress")}</Match>
                              <Match when={task.elsewhere}>{language.t("dialog.assignment.task.elsewhere")}</Match>
                            </Switch>
                          </span>
                        </div>
                        <Show when={task.place === "jolli_code" && !assignment().turnedIn}>
                          <Switch>
                            <Match when={task.local}>
                              {(local) => (
                                <ButtonV2
                                  variant={task.handedInAt ? "neutral" : "contrast"}
                                  size="normal"
                                  data-action="dialog-assignment-continue"
                                  onClick={() => resume(local())}
                                >
                                  {task.handedInAt
                                    ? language.t("dialog.assignment.task.open")
                                    : language.t("dialog.assignment.task.continue")}
                                </ButtonV2>
                              )}
                            </Match>
                            <Match when={!task.handedInAt && task.owed}>
                              <ButtonV2
                                variant="contrast"
                                size="normal"
                                data-action="dialog-assignment-start"
                                disabled={!sessions.session.canCreate()}
                                title={
                                  sessions.session.canCreate()
                                    ? undefined
                                    : language.t("dialog.assignment.task.noProject")
                                }
                                onClick={() => start(assignment(), task, index())}
                              >
                                {language.t("dialog.assignment.task.start")}
                              </ButtonV2>
                            </Match>
                          </Switch>
                        </Show>
                      </li>
                    )}
                  </For>
                </ul>
                <Show when={confirming()}>
                  <div
                    data-component="dialog-assignment-turn-in-confirm"
                    class="flex flex-col gap-1 rounded-lg bg-v2-background-bg-base px-3 py-2.5 text-[13px] leading-5 shadow-[var(--v2-elevation-raised)]"
                  >
                    <span class="text-v2-text-text-base">
                      {assignment().authorName
                        ? language.t("dialog.assignment.turnIn.confirm.named", { name: assignment().authorName! })
                        : language.t("dialog.assignment.turnIn.confirm")}
                    </span>
                    <Show when={turnInRefusal()}>
                      {(message) => (
                        <span role="alert" class="text-v2-text-text-muted">
                          {message()}
                        </span>
                      )}
                    </Show>
                  </div>
                </Show>
              </>
            )}
          </Match>
        </Switch>
      </DialogBody>
      <DialogFooter>
        <Show
          when={loaded()}
          fallback={
            <ButtonV2 variant="neutral" size="normal" onClick={() => dialog.close()}>
              {language.t("common.close")}
            </ButtonV2>
          }
        >
          {(assignment) => (
            <Switch
              fallback={
                <ButtonV2 variant="neutral" size="normal" onClick={() => dialog.close()}>
                  {language.t("common.close")}
                </ButtonV2>
              }
            >
              <Match when={assignment().turnedIn}>
                <span class="text-[13px] text-v2-text-text-muted">{language.t("dialog.assignment.turnedIn")}</span>
                <ButtonV2 variant="neutral" size="normal" onClick={() => dialog.close()}>
                  {language.t("common.close")}
                </ButtonV2>
              </Match>
              <Match when={confirming()}>
                <ButtonV2 variant="neutral" size="normal" disabled={turning()} onClick={() => setConfirming(false)}>
                  {language.t("common.cancel")}
                </ButtonV2>
                <ButtonV2
                  variant="contrast"
                  size="normal"
                  data-action="dialog-assignment-turn-in-confirm"
                  disabled={turning()}
                  onClick={() => void confirmTurnIn()}
                >
                  {language.t("dialog.assignment.turnIn")}
                </ButtonV2>
              </Match>
              <Match when={assignment().readyToTurnIn}>
                <ButtonV2 variant="neutral" size="normal" onClick={() => dialog.close()}>
                  {language.t("common.close")}
                </ButtonV2>
                <ButtonV2
                  variant="contrast"
                  size="normal"
                  data-action="dialog-assignment-turn-in"
                  onClick={() => setConfirming(true)}
                >
                  {language.t("dialog.assignment.turnIn")}
                </ButtonV2>
              </Match>
            </Switch>
          )}
        </Show>
      </DialogFooter>
    </Dialog>
  )
}
