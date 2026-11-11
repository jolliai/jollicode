import { changeGroupChat } from "@/jolli/group-chat-media"
import { createMemo, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { Jolli } from "@opencode-ai/schema/jolli"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { Spinner } from "@opencode-ai/ui/spinner"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useServerSDK } from "@/context/server-sdk"
import type { ServerConnection } from "@/context/server"
import {
  beginGroupChatLeave,
  decodeChatAnswer,
  groupChatActionRefused,
  groupChatOutcomeUnknown,
  groupChatRefusal,
  useGroupChatAccount,
  useGroupChatLoss,
} from "@/jolli/group-chat"
import { groupChatGeneration } from "@/jolli/group-chat-state"
import { showToast } from "@/utils/toast"
import { isAttemptChat } from "@opencode-ai/core/jolli/group-chat-rules"
import { GroupChatPeopleDialog, GroupChatConfirmation } from "@/components/group-chat-dialogs"
import { GroupChatIcon } from "@/components/group-chat-icons"
import { homeGroupChatTitle } from "@/pages/home/home-sessions-controller"
import { APP_SIDEBAR_ROW_LABEL, AppSidebarRow } from "./app-sidebar-row"

export function AppSidebarGroupChatRow(props: {
  chat: Jolli.GroupChatSummary
  server: ServerConnection.Key
  onOpen: () => void
}) {
  const language = useLanguage()
  const layout = useLayout()
  const dialog = useDialog()
  const sdk = useServerSDK()
  const [state, setState] = createStore<{ open: boolean; detail?: Jolli.GroupChat }>({ open: false })
  const title = () => homeGroupChatTitle(props.chat, language)
  const active = createMemo(() => {
    const route = layout.route()
    return route.type === "groupChat" && route.chatId === props.chat.id && route.server === props.server
  })
  const hasMenu = createMemo(
    () => props.chat.ownership !== "shared" && (!state.detail || !isAttemptChat(state.detail.group)),
  )
  const lose = useGroupChatLoss()
  const account = useGroupChatAccount()
  const read = async () => decodeChatAnswer((await sdk().client.jolli.groupChat({ chatID: props.chat.id })).data)
  /**
   * Whether the account was reset since `generation` was read. An answer from before is the previous
   * account's: it neither opens a menu, nor fills a dialog, nor names its chat to whoever is signed in now.
   */
  const stale = (generation: number) => generation !== groupChatGeneration(props.server)
  /**
   * An answer saying the credential is gone drops every group chat this window holds, this row and its
   * dialogs included: the reset that says so may have been missed. Answers whether it did.
   */
  const signedOut = (answer: Jolli.GroupChatAnswer | undefined) => {
    if (answer?.status !== "signed-out") return false
    account.signOut(props.server)
    return true
  }
  const menu = async () => {
    if (props.chat.ownership === "shared") return
    const generation = groupChatGeneration(props.server)
    const answer = await read()
    if (stale(generation) || signedOut(answer)) return
    if (answer.status === "revoked") {
      lose(props.server, props.chat.id, title())
      return
    }
    if (
      !answer.chat ||
      answer.source === "cache" ||
      answer.chat.access === "reader" ||
      isAttemptChat(answer.chat.group)
    )
      return
    setState({ open: true, detail: answer.chat })
  }
  /**
   * A change from the people dialog. The chat is read back after it, and after one whose answer was lost,
   * which may have been made: the dialog follows the read and shows whether. The reader's own leave goes
   * through {@link leave}, which marks it first.
   */
  const action = async (body: Jolli.GroupChatAction): Promise<Jolli.GroupChatAnswer> => {
    if (body.type === "remove" && body.userId === state.detail?.viewerId)
      return (await leave(body.userId)) ?? { status: "unreachable" }
    const generation = groupChatGeneration(props.server)
    const answer = await changeGroupChat(sdk(), props.chat.id, body).catch(() => undefined)
    if (stale(generation) || signedOut(answer)) return answer ?? { status: "unreachable" }
    if (answer?.status === "revoked") lose(props.server, props.chat.id, title())
    if (answer?.status !== "ok" && !groupChatOutcomeUnknown(answer)) return answer ?? { status: "unreachable" }
    const refreshed = await read().catch(() => undefined)
    if (stale(generation) || signedOut(refreshed)) return answer ?? { status: "unreachable" }
    if (refreshed?.status === "revoked") lose(props.server, props.chat.id, title())
    // Replaced in place, so the open dialog follows the read and keeps nothing the read dropped.
    if (refreshed?.chat && refreshed.source !== "cache") setState("detail", reconcile(refreshed.chat))
    return answer ?? { status: "unreachable" }
  }
  /**
   * Leaving takes the chat out of the sidebar unless it is still shared with the reader to read. A leave
   * with no answer may have gone through, so its mark stays and the chat's read decides: out of the
   * chat is the leave done, and anything else is told as a chat that could not be reached, never as a
   * leave that failed. Answers the leave's own answer, so a refusal is told by the caller.
   */
  const leave = async (viewerId: number) => {
    const generation = groupChatGeneration(props.server)
    // Marked before the request, so the revocation that follows tells nobody, here or on an open page.
    const undoLeave = beginGroupChatLeave(props.server, props.chat.id)
    const answer = await changeGroupChat(sdk(), props.chat.id, { type: "remove", userId: viewerId }).catch(
      () => undefined,
    )
    if (groupChatActionRefused(answer)) {
      undoLeave()
      if (!stale(generation)) signedOut(answer)
      return answer
    }
    const after = await read().catch(() => undefined)
    if (stale(generation) || signedOut(after)) return answer
    const confirmed = after?.status === "ok" && after.source !== "cache"
    if (confirmed && after.chat?.access === "reader") return answer
    if (answer?.status === "ok" || answer?.status === "revoked" || after?.status === "revoked") {
      lose(props.server, props.chat.id, title(), true)
      return answer
    }
    showToast({ variant: "error", title: language.t("groupChat.unavailable") })
    return answer
  }
  /** The leave from the row's own menu, whose dialog is closed by then: a refusal is told in a toast. */
  const leaveFromMenu = (viewerId: number) =>
    void leave(viewerId).then((answer) => {
      if (!answer || !groupChatActionRefused(answer)) return
      const refusal = groupChatRefusal(answer, "action")
      showToast({ variant: "error", title: refusal.message ?? language.t(refusal.key) })
    })
  return (
    <div
      class="group/session relative flex min-w-0 items-center"
      onContextMenu={(event) => {
        event.preventDefault()
        void menu().catch(() => undefined)
      }}
    >
      <AppSidebarRow
        type="button"
        data-component="app-sidebar-group-chat-row"
        data-group-chat-id={props.chat.id}
        data-selected={active() ? "" : undefined}
        aria-current={active() ? "page" : undefined}
        title={title()}
        onClick={props.onOpen}
      >
        <span class="shrink-0 text-v2-icon-icon-muted">
          <GroupChatIcon />
        </span>
        <span class={APP_SIDEBAR_ROW_LABEL}>{title()}</span>
        <span
          class="relative flex size-6 shrink-0 items-center justify-center"
          classList={{
            "opacity-0": state.open,
            "group-hover/session:opacity-0": hasMenu(),
            "group-focus-within/session:opacity-0": hasMenu(),
          }}
        >
          <Show
            when={props.chat.processing}
            fallback={
              <Show when={!active() && props.chat.unreadCount > 0}>
                <span class="inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-center text-[11px] font-medium leading-none bg-v2-background-bg-layer-03 text-v2-text-text-base">
                  {props.chat.unreadCount > 99 ? "99+" : props.chat.unreadCount}
                </span>
              </Show>
            }
          >
            <span title={language.t("groupChat.answering")} role="img" aria-label={language.t("groupChat.answering")}>
              <Spinner class="size-3.5" />
            </span>
          </Show>
        </span>
      </AppSidebarRow>
      <Show when={hasMenu()}>
        <button
          type="button"
          class="absolute right-1.5 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded text-v2-text-text-muted opacity-0 group-hover/session:opacity-100 group-focus-within/session:opacity-100 data-[state=open]:opacity-100"
          data-state={state.open ? "open" : undefined}
          aria-label={language.t("groupChat.people")}
          onClick={() => void menu().catch(() => undefined)}
        >
          ···
        </button>
      </Show>
      <MenuV2
        modal={false}
        open={state.open}
        onOpenChange={(open) => {
          if (!open) setState("open", false)
        }}
        placement="bottom-start"
      >
        <MenuV2.Trigger as="span" aria-hidden="true" class="absolute bottom-0 left-2 h-0 w-0" />
        <MenuV2.Portal>
          <MenuV2.Content>
            <Show when={state.detail}>
              {(chat) => (
                <>
                  <MenuV2.Item
                    onSelect={() => dialog.show(() => <GroupChatPeopleDialog chat={chat()} action={action} />)}
                  >
                    {language.t("groupChat.rename")}
                  </MenuV2.Item>
                  <MenuV2.Item
                    onSelect={() =>
                      dialog.show(() => (
                        <GroupChatConfirmation
                          title={language.t("groupChat.leave")}
                          detail={language.t("groupChat.leaveConfirm")}
                          confirm={language.t("groupChat.leave")}
                          onConfirm={() => {
                            const viewer = chat().viewerId
                            if (viewer !== null) leaveFromMenu(viewer)
                          }}
                        />
                      ))
                    }
                  >
                    {language.t("groupChat.leave")}
                  </MenuV2.Item>
                </>
              )}
            </Show>
          </MenuV2.Content>
        </MenuV2.Portal>
      </MenuV2>
    </div>
  )
}
