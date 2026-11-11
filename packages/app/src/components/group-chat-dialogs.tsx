import { createMemo, createResource, createUniqueId, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { useServer, ServerConnection } from "@/context/server"
import { useNavigate } from "@solidjs/router"
import { Jolli } from "@opencode-ai/schema/jolli"
import { memberActions, isAttemptChat } from "@opencode-ai/core/jolli/group-chat-rules"
import { courseById, listedCourses } from "@/jolli/catalog"
import { groupChatCourses, groupChatDrops } from "@/jolli/group-chat-state"
import {
  decodeChatAnswer,
  groupChatActionNotice,
  groupChatOutcomeUnknown,
  groupChatRefusal,
  useCloseOnGroupChatReset,
  useGroupChatAccount,
  type GroupChatRefusal,
} from "@/jolli/group-chat"
import { showToast } from "@/utils/toast"
import { groupChatHref } from "@/utils/session-route"
import { ConversationDialog } from "@/components/conversation-dialog"

export function GroupChatConfirmation(props: {
  title: string
  detail: string
  confirm: string
  onConfirm: () => void
}) {
  const dialog = useDialog()
  const language = useLanguage()
  useCloseOnGroupChatReset()
  return (
    <Dialog fit>
      <DialogHeader>
        <DialogTitle>{props.title}</DialogTitle>
      </DialogHeader>
      <DialogBody class="group-chat-dialog">
        <p class="break-all whitespace-pre-wrap select-text">{props.detail}</p>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="outline" onClick={dialog.close}>
          {language.t("groupChat.cancel")}
        </ButtonV2>
        <ButtonV2
          onClick={() => {
            dialog.close()
            props.onConfirm()
          }}
        >
          {props.confirm}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}

export function GroupChatPeopleDialog(props: {
  chat: Jolli.GroupChat
  disabled?: boolean
  action: (body: Jolli.GroupChatAction) => Promise<Jolli.GroupChatAnswer>
}) {
  const language = useLanguage()
  const dialog = useDialog()
  const sdk = useServerSDK()
  const account = useGroupChatAccount()
  useCloseOnGroupChatReset()
  const [state, setState] = createStore<{
    search: string
    title: string
    busy: boolean
    failed?: GroupChatRefusal
  }>({ search: "", title: props.chat.title, busy: false })
  const actions = () => memberActions(props.chat, props.chat.viewerId ?? -1)
  const [people, { refetch }] = createResource(
    () => (actions().add && !props.disabled ? props.chat.courseId : undefined),
    async (courseId) => {
      const answer = decodeChatAnswer((await sdk().client.jolli.groupChatPeople({ courseId })).data)
      // The window drops the server's chats, and this dialog closes with them.
      if (answer.status === "signed-out") account.signOut(ServerConnection.key(sdk().server))
      if (answer.status !== "ok") throw new Error("Course people unavailable")
      return answer.people ?? []
    },
  )
  // A failed read stays in this dialog; reading the resource itself would throw it to the app.
  const roster = () => (people.error ? [] : (people() ?? []))
  const participants = createMemo(() =>
    props.chat.group.participants.filter((person) =>
      person.name.toLocaleLowerCase().includes(state.search.toLocaleLowerCase()),
    ),
  )
  const candidates = createMemo(() =>
    roster()
      .filter(
        (person) =>
          !props.chat.group.participants.some((member) => member.userId === person.userId) &&
          person.name.toLocaleLowerCase().includes(state.search.toLocaleLowerCase()),
      )
      .slice(0, 30),
  )
  /**
   * `action` reads the chat back after a change whose answer was lost, and this dialog follows that read,
   * so the change shows here if it was made; the notice says only that the chat could not be reached.
   */
  const run = async (body: Jolli.GroupChatAction) => {
    setState({ busy: true, failed: undefined })
    const answer = await props.action(body).catch(() => undefined)
    setState({ busy: false, failed: groupChatActionNotice(answer) })
  }
  /**
   * A change confirmed in a dialog of its own: this one is closed by then, so a refusal is told in a toast.
   * The reader's own leave with no answer is told by `action`, which reads the chat back and keeps the
   * leave's mark: the chat closing then is the leave going through.
   */
  const confirmed = (body: Jolli.GroupChatAction) =>
    void props
      .action(body)
      .catch(() => undefined)
      .then((answer) => {
        const own = body.type === "remove" && body.userId === props.chat.viewerId
        if (own && groupChatOutcomeUnknown(answer)) return
        const notice = groupChatActionNotice(answer)
        if (notice) showToast({ variant: "error", title: notice.message ?? language.t(notice.key) })
      })
  return (
    <Dialog fit>
      <DialogHeader>
        <DialogTitle>{language.t("groupChat.members", { count: props.chat.group.participants.length })}</DialogTitle>
      </DialogHeader>
      <DialogBody class="group-chat-dialog">
        <Show when={actions().rename && !props.disabled}>
          <form
            class="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              void run({ type: "rename", title: state.title })
            }}
          >
            <TextInputV2
              aria-label={language.t("groupChat.rename")}
              value={state.title}
              onInput={(event) => setState("title", event.currentTarget.value)}
            />
            <ButtonV2 size="small" variant="outline" type="submit" disabled={state.busy}>
              {language.t("groupChat.save")}
            </ButtonV2>
          </form>
        </Show>
        <TextInputV2
          autofocus
          aria-label={language.t("groupChat.searchPeople")}
          placeholder={language.t("groupChat.searchPeople")}
          value={state.search}
          onInput={(event) => setState("search", event.currentTarget.value)}
        />
        <Show when={isAttemptChat(props.chat.group)}>
          <p class="group-chat-muted">{language.t("groupChat.attemptPeople")}</p>
        </Show>
        <div class="group-chat-people-list">
          <For each={participants()}>
            {(person) => (
              <div class="group-chat-person-row">
                <span class="group-chat-avatar">{person.name.slice(0, 2)}</span>
                <span class="min-w-0 flex-1 truncate">{person.name}</span>
                <Show when={!props.disabled && actions().remove(person.userId)}>
                  <ButtonV2
                    size="small"
                    variant="ghost"
                    disabled={state.busy}
                    onClick={() =>
                      dialog.show(() => (
                        <GroupChatConfirmation
                          title={language.t("groupChat.remove")}
                          detail={language.t("groupChat.removeConfirm", { name: person.name })}
                          confirm={language.t("groupChat.remove")}
                          onConfirm={() => confirmed({ type: "remove", userId: person.userId })}
                        />
                      ))
                    }
                  >
                    {language.t("groupChat.remove")}
                  </ButtonV2>
                </Show>
              </div>
            )}
          </For>
          <Show when={actions().add && !props.disabled}>
            <Show when={people.error}>
              <div class="group-chat-person-row" role="alert">
                <span class="min-w-0 flex-1">{language.t("groupChat.actionFailed")}</span>
                <ButtonV2 size="small" variant="ghost" onClick={() => void refetch()}>
                  {language.t("groupChat.preview.retry")}
                </ButtonV2>
              </div>
            </Show>
            <For each={candidates()}>
              {(person) => (
                <div class="group-chat-person-row">
                  <span class="group-chat-avatar">{person.name.slice(0, 2)}</span>
                  <span class="min-w-0 flex-1 truncate">{person.name}</span>
                  <ButtonV2
                    size="small"
                    variant="outline"
                    disabled={state.busy}
                    onClick={() => void run({ type: "add", userIds: [person.userId] })}
                  >
                    {language.t("groupChat.add")}
                  </ButtonV2>
                </div>
              )}
            </For>
          </Show>
        </div>
        <Show when={state.failed}>
          {(refusal) => (
            <p role="alert" class="group-chat-error">
              {refusal().message ?? language.t(refusal().key)}
            </p>
          )}
        </Show>
      </DialogBody>
      <DialogFooter>
        <Show when={actions().leave && !props.disabled && props.chat.viewerId !== null}>
          <ButtonV2
            variant="ghost"
            disabled={state.busy}
            onClick={() => {
              const viewer = props.chat.viewerId
              if (viewer === null) return
              dialog.show(() => (
                <GroupChatConfirmation
                  title={language.t("groupChat.leave")}
                  detail={language.t("groupChat.leaveConfirm")}
                  confirm={language.t("groupChat.leave")}
                  onConfirm={() => confirmed({ type: "remove", userId: viewer })}
                />
              ))
            }}
          >
            {language.t("groupChat.leave")}
          </ButtonV2>
        </Show>
        <ButtonV2 variant="outline" onClick={dialog.close}>
          {language.t("groupChat.cancel")}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}

export function GroupChatCreateDialog(props: { courseId?: string; onBack?: () => void }) {
  const courseLabel = createUniqueId()
  const language = useLanguage()
  const sdk = useServerSDK()
  const server = useServer()
  const dialog = useDialog()
  const navigate = useNavigate()
  const account = useGroupChatAccount()
  useCloseOnGroupChatReset()
  const [state, setState] = createStore<{
    course: string
    search: string
    title: string
    selected: number[]
    busy: boolean
    error?: GroupChatRefusal
  }>({
    course: props.courseId ?? "",
    search: "",
    title: "",
    selected: [],
    busy: false,
  })
  const courses = () =>
    listedCourses().filter((course) => groupChatCourses(ServerConnection.key(sdk().server)).includes(course.id))
  const [people, { refetch }] = createResource(
    () => state.course || undefined,
    async (courseId) => {
      const answer = decodeChatAnswer((await sdk().client.jolli.groupChatPeople({ courseId })).data)
      // The window drops the server's chats, and this dialog closes with them.
      if (answer.status === "signed-out") account.signOut(ServerConnection.key(sdk().server))
      if (answer.status !== "ok") throw new Error("Unable to load group chat participants")
      return answer.people ?? []
    },
  )
  const matches = createMemo(() =>
    people.loading || people.error
      ? []
      : (people() ?? []).filter((person) => person.name.toLocaleLowerCase().includes(state.search.toLocaleLowerCase())),
  )
  const create = async () => {
    if (!state.course || !state.selected.length || state.busy || people.loading || people.error) return
    setState({ busy: true, error: undefined })
    const key = ServerConnection.key(sdk().server)
    const drops = groupChatDrops(key)
    const answer = await sdk()
      .client.jolli.groupChatCreate({
        courseId: state.course,
        participantIds: state.selected,
        ...(state.title.trim() ? { title: state.title.trim() } : {}),
      })
      .then((response) => decodeChatAnswer(response.data))
      .catch(() => undefined)
    // Dropped meanwhile (the credential went away or someone else signed in): the chat is not opened for them.
    if (drops !== groupChatDrops(key)) return
    if (answer?.status === "signed-out") {
      account.signOut(key)
      return
    }
    setState("busy", false)
    // A create with no answer that names the chat may have made it, which the list shows when it is next
    // read: it is not told as not made.
    if (!answer || answer.status !== "ok" || !answer.createdId) {
      setState(
        "error",
        answer && answer.status !== "ok" ? groupChatRefusal(answer, "action") : { key: "groupChat.unavailable" },
      )
      return
    }
    dialog.close()
    navigate(groupChatHref(key ?? server.key, answer.createdId))
  }
  return (
    <ConversationDialog title={language.t("groupChat.new")} onBack={props.onBack} busy={state.busy}>
      <form
        class="conversation-dialog-form"
        onSubmit={(event) => {
          event.preventDefault()
          void create()
        }}
      >
        <DialogBody class="conversation-dialog-fields">
          <p class="conversation-dialog-hint">{language.t("groupChat.newHint")}</p>
          <div class="conversation-dialog-field">
            <span id={courseLabel} class="conversation-dialog-label">
              {language.t("groupChat.course")}
            </span>
            <SelectV2
              appearance="large"
              class="conversation-dialog-select"
              contentClass="conversation-dialog-course-menu"
              triggerProps={{
                autofocus: !props.courseId,
                "aria-labelledby": courseLabel,
                ref: (element) => {
                  if (props.courseId) return
                  queueMicrotask(() => element.focus({ preventScroll: true }))
                },
              }}
              options={courses()}
              current={courses().find((course) => course.id === state.course)}
              value={(course) => course.id}
              label={(course) => `${course.code} · ${course.title}`}
              placeholder={language.t("groupChat.course")}
              disabled={state.busy}
              placement="bottom-start"
              gutter={6}
              sameWidth
              fitViewport
              onSelect={(course) => setState({ course: course?.id ?? "", selected: [] })}
            >
              {(course) => (
                <span class="conversation-dialog-course-option" title={`${course.code} · ${course.title}`}>
                  <span class="conversation-dialog-course-code">{course.code}</span>
                  <span class="conversation-dialog-course-title">{course.title}</span>
                </span>
              )}
            </SelectV2>
          </div>
          <label class="conversation-dialog-field">
            <span class="conversation-dialog-label">{language.t("groupChat.name")}</span>
            <TextInputV2
              autofocus={!!props.courseId}
              appearance="large"
              class="!w-full"
              disabled={state.busy}
              value={state.title}
              maxlength={200}
              onInput={(event) => setState("title", event.currentTarget.value)}
            />
          </label>
          <div class="conversation-dialog-field conversation-dialog-members">
            <span class="conversation-dialog-label">{language.t("groupChat.people")}</span>
            <TextInputV2
              appearance="large"
              class="!w-full"
              disabled={!state.course || state.busy}
              aria-label={language.t("common.search.placeholder")}
              placeholder={language.t("common.search.placeholder")}
              leadingIcon={<Icon name="magnifying-glass" />}
              value={state.search}
              onInput={(event) => setState("search", event.currentTarget.value)}
            />
            <Show when={state.course}>
              <div class="conversation-dialog-people" aria-busy={people.loading}>
                <Show when={people.loading}>
                  <p class="conversation-dialog-state" role="status">
                    {language.t("common.loading")}
                  </p>
                </Show>
                <Show when={!people.loading && people.error}>
                  <div class="conversation-dialog-state" role="alert">
                    <p>{language.t("groupChat.actionFailed")}</p>
                    <ButtonV2 type="button" size="small" variant="ghost" onClick={() => void refetch()}>
                      {language.t("session.share.retry")}
                    </ButtonV2>
                  </div>
                </Show>
                <Show when={!people.loading && !people.error && !matches().length}>
                  <p class="conversation-dialog-state">{language.t("ui.list.empty")}</p>
                </Show>
                <For each={matches()}>
                  {(person) => (
                    <label class="conversation-dialog-person">
                      <input
                        type="checkbox"
                        checked={state.selected.includes(person.userId)}
                        disabled={
                          state.busy || (!state.selected.includes(person.userId) && state.selected.length >= 49)
                        }
                        onChange={(event) =>
                          setState("selected", (ids) =>
                            event.currentTarget.checked
                              ? [...ids, person.userId]
                              : ids.filter((id) => id !== person.userId),
                          )
                        }
                      />
                      <span class="min-w-0 flex-1">{person.name}</span>
                    </label>
                  )}
                </For>
              </div>
            </Show>
          </div>
          <Show when={state.error}>
            {(error) => (
              <p class="conversation-dialog-hint conversation-dialog-error" role="alert">
                {error().message ?? language.t(error().key)}
              </p>
            )}
          </Show>
        </DialogBody>
        <DialogFooter>
          <ButtonV2 type="button" variant="outline" disabled={state.busy} onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </ButtonV2>
          <ButtonV2
            type="submit"
            variant={state.busy ? "loading" : "contrast"}
            disabled={
              state.busy || people.loading || !!people.error || !state.selected.length || !courseById(state.course)
            }
          >
            {state.busy ? language.t("common.loading") : language.t("groupChat.create")}
          </ButtonV2>
        </DialogFooter>
      </form>
    </ConversationDialog>
  )
}
