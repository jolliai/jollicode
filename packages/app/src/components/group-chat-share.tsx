import { createResource, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Schema } from "effect"
import type { Jolli } from "@opencode-ai/schema/jolli"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useServerSDK } from "@/context/server-sdk"
import { useLanguage } from "@/context/language"
import { decodeChatAnswer, groupChatRefusal, type GroupChatRefusal } from "@/jolli/group-chat"

const Share = Schema.Struct({
  subjectIsClass: Schema.Boolean,
  subjectIsGroup: Schema.Boolean.pipe(Schema.optional),
  subjectUserId: Schema.Int.pipe(Schema.optional),
  groupId: Schema.Int.pipe(Schema.optional),
  name: Schema.String.pipe(Schema.optional),
  groupName: Schema.String.pipe(Schema.optional),
  canRevoke: Schema.Boolean.pipe(Schema.optional),
})
const ShareSnapshot = Schema.Struct({
  visibility: Schema.Struct({ shares: Schema.Array(Share).pipe(Schema.optional) }),
  role: Schema.String,
  members: Schema.Array(
    Schema.Struct({
      userId: Schema.Int,
      role: Schema.String,
      userName: Schema.NullOr(Schema.String),
      userEmail: Schema.String,
    }),
  ),
  board: Schema.Struct({ groups: Schema.Array(Schema.Struct({ id: Schema.Int, name: Schema.String })) }),
})

/** `onAnswer` hears every answer, so the page can act on lost access the way it does for its own requests. */
export function GroupChatShareDialog(props: {
  chat: Jolli.GroupChat
  onAnswer?: (answer: Jolli.GroupChatAnswer) => void
}) {
  const language = useLanguage()
  const dialog = useDialog()
  const sdk = useServerSDK()
  const [state, setState] = createStore<{ search: string; busy: boolean; error?: GroupChatRefusal }>({
    search: "",
    busy: false,
  })
  const [snapshot, { refetch }] = createResource(async () => {
    const answer = decodeChatAnswer((await sdk().client.jolli.groupChatShare({ chatID: props.chat.id })).data)
    props.onAnswer?.(answer)
    if (answer.status !== "ok") throw new Error("Group chat shares unavailable")
    return Schema.decodeUnknownSync(ShareSnapshot)(answer.resource)
  })
  // A failed read stays in this dialog; reading the resource itself would throw it to the app.
  const shares = () => (snapshot.error ? undefined : snapshot())
  const write = async (subject: number | "everyone" | { groupId: number }, remove = false) => {
    setState({ busy: true, error: undefined })
    try {
      const response = remove
        ? typeof subject === "object"
          ? await sdk().client.jolli.groupChatShareGroupRemove({
              chatID: props.chat.id,
              groupId: String(subject.groupId),
            })
          : await sdk().client.jolli.groupChatShareRemove({ chatID: props.chat.id, subject: String(subject) })
        : await sdk().client.jolli.groupChatShareAdd({ chatID: props.chat.id, subject })
      const answer = decodeChatAnswer(response.data)
      props.onAnswer?.(answer)
      if (answer.status !== "ok") {
        setState("error", groupChatRefusal(answer, "action"))
        return
      }
      await refetch()
    } catch {
      setState("error", { key: "groupChat.actionFailed" })
    } finally {
      setState("busy", false)
    }
  }
  const candidates = () => {
    const data = shares()
    if (!data) return []
    const people = new Map<number, { userId: number; name: string; staff: boolean }>()
    for (const member of data.members) {
      const staff = ["space-owner", "space-manager", "course-instructor"].includes(member.role)
      if (!staff && data.role !== "staff") continue
      if (
        member.userId === props.chat.viewerId ||
        props.chat.group.participants.some((person) => person.userId === member.userId)
      )
        continue
      if (data.visibility.shares?.some((share) => share.subjectUserId === member.userId)) continue
      const name = member.userName || member.userEmail
      if (name.toLocaleLowerCase().includes(state.search.toLocaleLowerCase()))
        people.set(member.userId, { userId: member.userId, name, staff })
    }
    return [...people.values()].slice(0, 30)
  }
  return (
    <Dialog fit>
      <DialogHeader>
        <DialogTitle>{language.t("groupChat.share")}</DialogTitle>
      </DialogHeader>
      <DialogBody class="group-chat-dialog">
        <p class="group-chat-muted">{language.t("groupChat.shareHint")}</p>
        <Show when={shares()?.role === "student"}>
          <p class="group-chat-muted">{language.t("groupChat.staffOnly")}</p>
        </Show>
        <TextInputV2
          autofocus
          aria-label={language.t("groupChat.searchPeople")}
          placeholder={language.t("groupChat.searchPeople")}
          value={state.search}
          onInput={(event) => setState("search", event.currentTarget.value)}
        />
        <div class="group-chat-people-list">
          <For each={candidates()}>
            {(person) => (
              <div class="group-chat-person-row">
                <span class="group-chat-avatar">{person.name.slice(0, 2)}</span>
                <span class="min-w-0 flex-1 truncate">{person.name}</span>
                <ButtonV2
                  size="small"
                  variant="outline"
                  disabled={state.busy}
                  onClick={() => void write(person.userId)}
                >
                  {language.t("groupChat.share")}
                </ButtonV2>
              </div>
            )}
          </For>
          <Show when={shares()?.role === "staff"}>
            <div class="group-chat-person-row">
              <span class="min-w-0 flex-1">{language.t("groupChat.shareClass")}</span>
              <ButtonV2 size="small" variant="outline" disabled={state.busy} onClick={() => void write("everyone")}>
                {language.t("groupChat.share")}
              </ButtonV2>
            </div>
            <For each={shares()?.board.groups ?? []}>
              {(group) => (
                <div class="group-chat-person-row">
                  <span class="min-w-0 flex-1 truncate">{group.name}</span>
                  <ButtonV2
                    size="small"
                    variant="outline"
                    disabled={state.busy}
                    onClick={() => void write({ groupId: group.id })}
                  >
                    {language.t("groupChat.share")}
                  </ButtonV2>
                </div>
              )}
            </For>
          </Show>
        </div>
        <For each={shares()?.visibility.shares ?? []}>
          {(share) => (
            <div class="group-chat-person-row">
              <span class="min-w-0 flex-1 truncate">
                {share.subjectIsClass ? language.t("groupChat.shareClass") : share.groupName || share.name}
              </span>
              <Show when={share.canRevoke === true}>
                <ButtonV2
                  size="small"
                  variant="ghost"
                  disabled={state.busy}
                  onClick={() => {
                    const subject = share.subjectIsClass
                      ? "everyone"
                      : share.subjectIsGroup && share.groupId !== undefined
                        ? { groupId: share.groupId }
                        : share.subjectUserId
                    if (subject !== undefined) void write(subject, true)
                  }}
                >
                  {language.t("groupChat.revoke")}
                </ButtonV2>
              </Show>
            </div>
          )}
        </For>
        <Show when={state.error ?? (snapshot.error ? { key: "groupChat.actionFailed" as const } : undefined)}>
          {(error) => (
            <p class="group-chat-error" role="alert">
              {error().message ?? language.t(error().key)}
            </p>
          )}
        </Show>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="outline" onClick={dialog.close}>
          {language.t("groupChat.cancel")}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}
