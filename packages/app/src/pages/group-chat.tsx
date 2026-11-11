import type { GroupChatAttachmentDraft } from "@/jolli/group-chat-media"
import { parseOrgScopedId } from "@opencode-ai/core/jolli/org-scoped-id"
import { composerTargetFallback, replaceAliases } from "@opencode-ai/core/jolli/group-chat-rules"
import { GroupChatShareDialog } from "@/components/group-chat-share"
import { GroupChatMaterialsDialog } from "@/components/group-chat-materials"
import { GroupChatSources } from "@/components/group-chat-sources"
import { ReferenceDock } from "@/components/reference-dock"
import { GroupChatArtifactCard } from "@/components/group-chat-artifact-card"
import { referencePreviewOf, scopedReferencePreview, type ReferencePreview } from "@/jolli/reference-preview"
import { useGroupChatAttachments, groupAttachmentFile, changeGroupChat } from "@/jolli/group-chat-media"
import { ChatFileDownloadError, downloadChatFile } from "@/jolli/reference-download"
import { useGroupChatVoice } from "@/jolli/group-chat-voice"
import { GroupChatIcon } from "@/components/group-chat-icons"
import { createEffect, createMemo, ErrorBoundary, For, on, onCleanup, onMount, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useParams } from "@solidjs/router"
import { Jolli } from "@opencode-ai/schema/jolli"
import { Markdown } from "@opencode-ai/session-ui/markdown"
import type { PromptInputV2PersistedState } from "@opencode-ai/session-ui/v2/prompt-input"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useServerSDK } from "@/context/server-sdk"
import { useTabs } from "@/context/tabs"
import { useLanguage } from "@/context/language"
import { groupChatRouteId, requireServerKey } from "@/utils/session-route"
import { showToast } from "@/utils/toast"
import {
  beginGroupChatLeave,
  decodeChatAnswer,
  canStopGroupAnswer,
  groupChatActionNotice,
  groupChatActionRefused,
  groupChatMarkerSettled,
  groupChatOutcomeUnknown,
  groupChatRefusal,
  groupChatRefusalNeedsRead,
  groupChatRefusalPasses,
  groupMessagePayload,
  runningGroupTurn,
  useGroupChatAccount,
  useGroupChatLoss,
  type GroupChatRefusal,
} from "@/jolli/group-chat"
import { groupChatSourcesByMessage } from "@/jolli/group-chat-sources"
import { createGroupChatFollow } from "@/jolli/group-chat-follow"
import { createGroupChatFeatures } from "@/jolli/group-chat-features"
import { groupChatDrops, markGroupChatRead } from "@/jolli/group-chat-state"
import { assistantsForCourse, courseById } from "@/jolli/catalog"
import { GroupChatComposer } from "@/components/group-chat-composer"
import { groupChatDictation } from "@/jolli/group-chat-composer"
import { GroupChatConfirmation, GroupChatPeopleDialog } from "@/components/group-chat-dialogs"
import { useConfirmation, useExternalLinkConfirm } from "@/components/external-link-confirm"
import { guardExternalLinks } from "@/jolli/external-link"
import { SessionRouteFrame } from "@/components/session/session-route-frame"
import "@/components/reference-preview.css"
import "./group-chat.css"

/** How long a read marker that did not get through first waits before it is sent again. */
const MARK_PAUSE_MS = 5_000

export default function GroupChatRoute() {
  const params = useParams<{ id: string; serverKey: string }>()
  const language = useLanguage()
  return (
    <SessionRouteFrame>
      {/* A failure inside the chat or one of its dialogs stays on this page instead of replacing the app. */}
      <ErrorBoundary fallback={(_, reset) => <GroupChatNotice text={language.t("groupChat.crashed")} retry={reset} />}>
        <Show when={params.id} keyed>
          {(raw) => (
            <Show
              when={groupChatRouteId(raw)}
              keyed
              fallback={<GroupChatNotice text={language.t("groupChat.notFound")} />}
            >
              {(id) => <GroupChatPage id={id} serverKey={params.serverKey} />}
            </Show>
          )}
        </Show>
      </ErrorBoundary>
    </SessionRouteFrame>
  )
}

function GroupChatNotice(props: { text: string; retry?: () => void }) {
  const language = useLanguage()
  return (
    <section class="group-chat-page" data-testid="group-chat-page">
      <div class="group-chat-empty" role="alert">
        <div class="group-chat-empty-mark">
          <GroupChatIcon />
        </div>
        <p>{props.text}</p>
        <Show when={props.retry}>
          {(retry) => (
            <ButtonV2 variant="outline" size="small" onClick={() => retry()()}>
              {language.t("groupChat.preview.retry")}
            </ButtonV2>
          )}
        </Show>
      </div>
    </section>
  )
}

function GroupChatPage(props: { id: Jolli.GroupChatID; serverKey: string }) {
  const sdk = useServerSDK()
  const tabs = useTabs()
  const language = useLanguage()
  const dialog = useDialog()
  const openLink = useExternalLinkConfirm()
  const confirm = useConfirmation()
  const lose = useGroupChatLoss()
  const account = useGroupChatAccount()
  const [state, setState] = createStore<{
    answer?: Jolli.GroupChatAnswer
    loading: boolean
    /** The server could not be reached; whatever was read last stays on screen. */
    failed: boolean
    /** Why the server refused to open the chat, while it does. */
    refusal?: GroupChatRefusal
    stream: string
    seq: number
    frameSeq: number
    truncatedAnswer: boolean
    stopping: boolean
    /** This reader's own question, until the chat's read lists its turn. */
    asking?: { assistantId: number; askerId: number }
  }>({
    loading: true,
    failed: false,
    stream: "",
    seq: -1,
    frameSeq: 0,
    truncatedAnswer: false,
    stopping: false,
  })
  const id = () => props.id
  const server = () => requireServerKey(props.serverKey)
  const chat = () => state.answer?.chat
  const offline = () => state.answer?.source === "cache"
  /** Nothing new can be sent: the copy is offline, the server is out of reach, or it will not let the reader in. */
  const halted = () => offline() || state.failed || state.refusal !== undefined
  const writable = () => {
    const value = chat()
    return value !== undefined && value.access !== "reader" && !value.locked && !halted()
  }
  const title = () => {
    const value = chat()
    if (!value) return language.t("groupChat.title")
    return value.title || language.t("groupChat.unnamed", { count: value.group.participants.length })
  }
  const sources = createMemo(() => groupChatSourcesByMessage(chat()?.messages ?? []))
  const staff = () =>
    courseById(chat()?.courseId ?? "")?.isStaff === true ||
    chat()?.group.participants.some((person) => person.userId === chat()?.viewerId && person.role === "staff") === true
  const tab = () => ({ type: "groupChat" as const, server: server(), chatId: id() })
  const [references, setReferences] = tabs.state(tab(), "group-chat-references", () =>
    createStore<{ items: ReferencePreview[]; active?: string; opening: number; expanded: boolean; width: number }>({
      items: [],
      opening: 0,
      expanded: false,
      width: 480,
    }),
  )
  const activeReference = createMemo(() => references.items.find((item) => item.key === references.active))
  const referenceTriggers = new Map<string, WeakRef<HTMLElement>>()
  const openReference = (item: ReferencePreview, trigger?: HTMLElement) => {
    const selected = scopedReferencePreview({ kind: "group", chatID: id() }, item)
    if (trigger) referenceTriggers.set(selected.key, new WeakRef(trigger))
    setReferences("items", (items) =>
      items.some((entry) => entry.key === selected.key)
        ? items.map((entry) => (entry.key === selected.key ? selected : entry))
        : [...items, selected],
    )
    setReferences({ active: selected.key, opening: references.opening + 1 })
  }
  const closeReference = (key: string) => {
    setReferences("items", (items) => items.filter((item) => item.key !== key))
    if (references.active === key) setReferences({ active: references.items.at(-1)?.key, expanded: false })
    const trigger = referenceTriggers.get(key)?.deref()
    if (trigger?.isConnected) trigger.focus()
    referenceTriggers.delete(key)
  }
  const draft = createMemo(() =>
    tabs.state(tab(), "group-chat-draft", () =>
      createStore<PromptInputV2PersistedState>({
        prompt: [{ type: "text", content: "", start: 0, end: 0 }],
        context: { items: [] },
      }),
    ),
  )
  const clearDraft = () => draft()[1]("prompt", [{ type: "text", content: "", start: 0, end: 0 }])
  const attachmentDraft = tabs.state(tab(), "group-chat-attachments", () =>
    createStore<GroupChatAttachmentDraft>({ files: [], materials: [], error: false }),
  )
  const attachments = useGroupChatAttachments(sdk, id, attachmentDraft, () => account.signOut(server()))
  const voice = useGroupChatVoice({
    sdk,
    id,
    locale: language.intl,
    append: (text) => draft()[1]("prompt", (prompt) => groupChatDictation(prompt, text)),
  })
  // The agent this reader last asked, as the server remembers it; `saving` holds off reads that predate a change.
  const [target, setTarget] = createStore<{ assistantId: number | null; saving: number }>({
    assistantId: null,
    saving: 0,
  })
  const remembered = () => composerTargetFallback(target.assistantId, chat()?.group.mentionable ?? [])
  const agentName = (assistantId: number | null) =>
    chat()?.group.mentionable?.find((agent) => agent.id === assistantId)?.name ||
    assistantsForCourse(chat()?.courseId).find((agent) => Number(agent.id.split(":").at(-1)) === assistantId)?.name
  /** The remembered agent may no longer be asked here, so messages go to the group; undefined while it may. */
  const pausedTarget = () => {
    if (target.assistantId === null || remembered() !== null || !chat()) return undefined
    return agentName(target.assistantId) ?? ""
  }
  let picker: HTMLInputElement | undefined
  const pick = () => picker?.click()
  // Files are taken only where this reader can send them; a read-only, locked or offline chat ignores them.
  const files = (items: readonly File[]) => {
    if (writable() && voice.state.mode === "idle") void attachments.add(items)
  }
  const systemText = (message: Jolli.ChatMessage) => {
    if (
      message.role !== "system" ||
      !message.payload ||
      typeof message.payload !== "object" ||
      Array.isArray(message.payload) ||
      !("chatEvent" in message.payload)
    )
      return message.content
    const raw = message.payload.chatEvent
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || !("kind" in raw)) return message.content
    const kind = raw.kind
    if (
      kind !== "created" &&
      kind !== "added" &&
      kind !== "removed" &&
      kind !== "left" &&
      kind !== "renamed" &&
      kind !== "shared" &&
      kind !== "unshared"
    )
      return message.content
    const actor =
      typeof raw.actorId === "number"
        ? (people().get(raw.actorId) ?? language.t("groupChat.people"))
        : language.t("groupChat.people")
    const subjects = Array.isArray(raw.subjectIds)
      ? raw.subjectIds
          .flatMap((id) => (typeof id === "number" ? [people().get(id) ?? ""] : []))
          .filter(Boolean)
          .join(", ")
      : ""
    return language.t(`groupChat.event.${kind}`, {
      actor,
      people: subjects,
      title: typeof raw.title === "string" ? raw.title : "",
    })
  }
  /**
   * Downloads on their way, ended with the page and by {@link drop}: a file of a chat this reader left, or
   * of the previous account, is neither confirmed nor saved once it arrives.
   */
  let downloads = new AbortController()
  onCleanup(() => downloads.abort())
  /** A failed download is that file's alone: it is reported for the file and never stops the chat. */
  const download = (attachment: { attachmentId: number; filename: string; mimeType?: string }) =>
    void downloadChatFile({
      source: (signal) => groupAttachmentFile(sdk(), id(), attachment.attachmentId, attachment.filename, signal),
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      allowExecutable: () =>
        confirm({
          title: language.t("groupChat.download"),
          detail: language.t("groupChat.unsafeFile"),
          confirm: language.t("groupChat.download"),
        }),
      signal: downloads.signal,
    }).catch((error: unknown) => {
      showToast({ variant: "error", title: language.t("groupChat.downloadFailed", { name: attachment.filename }) })
      // A refused file may mean the reader lost the chat; the chat's own read decides.
      if (error instanceof ChatFileDownloadError && (error.status === 403 || error.status === 404)) void refresh()
    })
  const openMaterial = (materialId: number, title: string) => {
    const current = chat()
    const course = parseOrgScopedId(current?.courseId ?? "")
    if (!current?.webBaseUrl || !course) return
    openReference({
      key: `material:${materialId}`,
      title,
      reference: { kind: "material", materialId },
      url: `${current.webBaseUrl}/${staff() ? "courses" : "learn"}/${course.id}/materials/${materialId}`,
    })
  }

  let generation = 0
  let inflight: { run: number; promise: Promise<void> } | undefined
  let again = false
  let lastMarked = -1
  let pendingRead = -1
  let atBottom = true
  /** Set by this reader's own leave, which needs no notice that access is gone. */
  let leaving = false
  /** Counts answers that started on the live stream, so a read can tell it predates the one now streaming. */
  let answerStarts = 0
  /** The reader's access as the server itself last told it; an offline copy may predate it. */
  let confirmedAccess: Jolli.GroupChat["access"] | undefined
  /** Asks this connection to follow the chat's live updates again; set while the page follows a chat. */
  let rewatch: (() => void) | undefined
  const follow = createGroupChatFollow({ read: () => void refresh(), watch: () => rewatch?.() })
  /**
   * No read marker is sent before `markPause`: one that was turned away for now, or got no answer, is sent
   * again after `markDelay`, longer each time it fails again.
   */
  let markPause = 0
  let markDelay = 0
  let markRetry: ReturnType<typeof setTimeout> | undefined
  let scroller: HTMLDivElement | undefined
  /**
   * Drops everything this page holds for the chat, including a dialog still open on it and a download on
   * its way. A read still out is dropped when it answers too: after a reset it may be the previous
   * account's, and after lost access it would bring the chat back.
   */
  const drop = () => {
    generation++
    follow.stop()
    clearTimeout(markRetry)
    downloads.abort()
    downloads = new AbortController()
    dialog.close()
    setReferences({ items: [], active: undefined, expanded: false })
    attachments.clear()
    void voice.stop()
    setState({ answer: undefined, stream: "", asking: undefined })
  }
  const loseAccess = () => {
    const known = chat() ? title() : undefined
    const quiet = leaving
    leaving = false
    drop()
    lose(server(), id(), known, quiet)
  }
  /**
   * No credential any more: nothing of the chats stays in this window, this page included (it drops on
   * the server's drop count, and its tab closes). The sidecar's reset says so too, but may have been missed.
   */
  const signOut = () => account.signOut(server())
  // Every drop of this server's chats in this window: a reset, a lost sign-in, or a list of somebody else's.
  createEffect(on(() => groupChatDrops(server()), drop, { defer: true }))
  // Read for every chat the page shows (see the effect below), and again after anything that may have changed them.
  const features = createGroupChatFeatures({
    read: () =>
      sdk()
        .client.jolli.groupChatFeatures({ chatID: id() })
        .then((response) => decodeChatAnswer(response.data)),
    generation: () => generation,
    signOut,
  })
  /** What every request except the open read does with lost access, a lost sign-in, or a refusal that may mean either. */
  const settle = (answer: Jolli.GroupChatAnswer) => {
    if (answer.status === "revoked") {
      loseAccess()
      return
    }
    if (answer.status === "signed-out") {
      signOut()
      return
    }
    if (groupChatRefusalNeedsRead(answer)) void refresh()
  }
  const apply = (answer: Jolli.GroupChatAnswer | undefined, startsBefore: number) => {
    if (answer?.status === "signed-out") {
      signOut()
      return
    }
    // Turned away for now (a timeout, a rate limit, an org the request could not be placed in, the
    // account changing under it) is no more an answer about the chat than no answer at all, and is
    // asked again on its own like one.
    const reached =
      answer !== undefined &&
      answer.status !== "unreachable" &&
      answer.source !== "cache" &&
      !groupChatRefusalPasses(answer)
    follow.read({ reached })
    if (!answer || answer.status === "unreachable") {
      setState("failed", true)
      return
    }
    if (answer.status === "revoked") {
      loseAccess()
      return
    }
    if (answer.status !== "ok" || !answer.chat) {
      setState({ refusal: groupChatRefusal(answer, "open"), failed: false })
      return
    }
    const recovering =
      offline() || state.failed || !features.status.loaded || features.capabilities.composer?.unavailable === true
    if (answer.chat.access === "reader") leaving = false
    setState("answer", reconcile(answer))
    setState({ failed: false, refusal: undefined })
    // A read made before the stream started the next answer says "not processing" about the last one;
    // it must not wipe the text that has arrived since.
    if (!answer.chat.processing && startsBefore === answerStarts)
      setState({ stream: "", seq: -1, frameSeq: 0, asking: undefined })
    if (!target.saving) setTarget("assistantId", answer.chat.group.composerTargetAssistantId ?? null)
    // Becoming a reader drops what only a participant could send, once the server itself says so: an
    // offline copy may be older than the access it shows. Later reads leave a read-aloud playing.
    if (reached && answer.chat.access === "reader" && confirmedAccess !== "reader") {
      void voice.stop()
      attachments.clear()
      clearDraft()
    }
    if (reached) confirmedAccess = answer.chat.access
    tabs.setGroupChatInfo(tab(), title())
    if (recovering && answer.source !== "cache" && !features.status.loading) void features.load()
  }
  /** One read at a time per connection; a read asked for meanwhile runs once after it. */
  const refresh = (): Promise<void> => {
    if (inflight?.run === generation) {
      again = true
      return inflight.promise
    }
    const run = generation
    const startsBefore = answerStarts
    again = false
    const promise: Promise<void> = sdk()
      .client.jolli.groupChat({ chatID: id() })
      .then((response) => decodeChatAnswer(response.data))
      .catch(() => undefined)
      .then(async (answer) => {
        if (run !== generation) return
        // Another owner than the one whose chats this window holds drops them all, this page with its tab.
        // The window's record loads asynchronously, so a drop meanwhile is checked for again after it.
        if (await account.otherOwner(server(), answer)) return
        if (run === generation) apply(answer, startsBefore)
      })
      .finally(() => {
        if (inflight?.promise === promise) inflight = undefined
        if (run !== generation) return
        setState("loading", false)
        if (!again) return
        again = false
        void refresh()
      })
    inflight = { run, promise }
    return promise
  }
  const action = async (body: Jolli.GroupChatAction) => {
    const own = body.type === "remove" && body.userId === chat()?.viewerId
    // Set before the request: the live stream can report the lost access before this answer arrives,
    // to this page and to the app-wide listener alike.
    if (own) leaving = true
    const undoLeave = own ? beginGroupChatLeave(server(), id()) : undefined
    // A change to the chat itself shows in its read. A change with no answer may still have been made,
    // so the read is asked for then too. The reader's own marker and recipient are not read back.
    const shown = body.type !== "read" && body.type !== "target"
    const answer = await changeGroupChat(sdk(), id(), body).catch((error: unknown) => {
      // A leave with no answer may have gone through, so its mark stays and the read shows which.
      if (shown) void refresh()
      throw error
    })
    // Only a leave the server turned down is undone. Gone (`revoked`) is out of the chat as well, and a
    // lost answer is decided by the read.
    if (own && groupChatActionRefused(answer)) {
      leaving = false
      undoLeave?.()
    }
    settle(answer)
    if (shown && answer.status === "unreachable") void refresh()
    if (shown && answer.status === "ok") await refresh()
    return answer
  }
  const stopAnswer = async () => {
    if (state.stopping || halted() || !canStopGroupAnswer(chat(), state.asking)) return
    setState("stopping", true)
    const answer = await action({ type: "cancel" }).catch(() => undefined)
    setState("stopping", false)
    // A stop with no answer may have stopped the answer: `action` reads the chat again, which shows whether,
    // and the page's banner says when the chat cannot be reached. A lost sign-in has dropped the chat.
    if (groupChatOutcomeUnknown(answer) || answer?.status === "signed-out") return
    const notice = groupChatActionNotice(answer)
    if (notice) showToast({ variant: "error", title: notice.message ?? language.t(notice.key) })
  }
  /** Picking or clearing an agent updates the remembered recipient before the next message is sent. */
  const chooseTarget = (assistantId: number | null) => {
    setTarget({ assistantId, saving: target.saving + 1 })
    void action({ type: "target", assistantId: assistantId ?? undefined })
      .catch(() => undefined)
      .finally(() => setTarget("saving", (count) => count - 1))
  }
  const post = async (body: Jolli.GroupChatPost) => {
    const answer = await sdk()
      .client.jolli.groupChatPost({
        chatID: id(),
        ...body,
        mentionedUserIds: body.mentionedUserIds ? [...body.mentionedUserIds] : undefined,
        attachmentIds: body.attachmentIds ? [...body.attachmentIds] : undefined,
        pinnedMaterialIds: body.pinnedMaterialIds ? [...body.pinnedMaterialIds] : undefined,
      })
      .then((response) => decodeChatAnswer(response.data))
      .catch((error: unknown) => {
        // A message with no answer may still have arrived; the chat's read shows whether before a retry.
        void refresh()
        throw error
      })
    if (answer.status === "ok") {
      attachments.accepted(body.attachmentIds ?? [], body.pinnedMaterialIds ?? [])
      const asked = body.mentionedAssistantId
      const viewer = chat()?.viewerId
      if (asked !== undefined) {
        setTarget("assistantId", asked)
        if (viewer !== undefined && viewer !== null) setState("asking", { assistantId: asked, askerId: viewer })
      }
      void refresh()
      return answer
    }
    settle(answer)
    if (answer.status === "unreachable") void refresh()
    if (answer.status === "refused" && answer.code === undefined && body.attachmentIds?.length)
      void attachments.recheck()
    return answer
  }
  const markRead = () => {
    if (!atBottom || offline() || !document.hasFocus() || document.visibilityState === "hidden") return
    const seq = chat()?.messages.at(-1)?.seq
    if (seq === undefined || seq <= lastMarked || seq <= pendingRead || Date.now() < markPause) return
    pendingRead = seq
    const run = generation
    /** Sends the marker again after a pause, so neither scrolling nor a server that keeps refusing floods it. */
    const pause = () => {
      if (run !== generation) return
      markDelay = Math.min(markDelay * 2 || MARK_PAUSE_MS, 60_000)
      markPause = Date.now() + markDelay
      clearTimeout(markRetry)
      markRetry = setTimeout(() => {
        markPause = 0
        markRead()
      }, markDelay)
    }
    void changeGroupChat(sdk(), id(), { type: "read", seq })
      .then((answer) => {
        if (run !== generation) return
        if (answer.status === "revoked" || answer.status === "signed-out") settle(answer)
        // A marker the server refused for good is not asked again for the same message, and says nothing
        // about the chat itself. One turned away for now, or with no answer, is sent again after a pause.
        const settled = groupChatMarkerSettled(answer)
        if (settled) {
          lastMarked = Math.max(lastMarked, seq)
          markDelay = 0
        }
        if (!settled) pause()
        if (answer.status === "ok") markGroupChatRead(server(), id())
      })
      .catch(pause)
      .finally(() => {
        if (pendingRead === seq) pendingRead = -1
      })
  }
  createEffect(
    on(
      () => [id(), sdk()] as const,
      ([current, client]) => {
        generation++
        confirmedAccess = undefined
        follow.reset()
        clearTimeout(markRetry)
        markPause = 0
        markDelay = 0
        setState({
          answer: undefined,
          stream: "",
          seq: -1,
          frameSeq: 0,
          loading: true,
          failed: false,
          refusal: undefined,
          asking: undefined,
        })
        tabs.addGroupChatTab({ server: server(), chatId: current })
        // Cleared on cleanup: the first read can answer after the page left this chat, and a watch
        // asked for then would hold an upstream subscription nobody releases.
        let live = true
        /** Follows the chat's live updates; one that does not get through is asked again with the read. */
        const watch = () => {
          if (!live) return
          follow.watching()
          void client.client.jolli
            .groupChatWatch({ chatID: current, clientID: client.clientID, active: true })
            .then((response) => decodeChatAnswer(response.data))
            .catch(() => undefined)
            .then((answer) => {
              if (!live) return
              if (answer?.status === "signed-out") {
                signOut()
                return
              }
              follow.watched({ ok: answer?.status === "ok" })
            })
        }
        rewatch = watch
        void refresh().then(watch)
        void features.load()
        /** Reads the chat again and follows it again, after anything that may have stopped either. */
        const resume = () => {
          watch()
          void refresh()
          if (!features.status.loading) void features.load()
        }
        const stop = client.event.listen((event) => {
          const data = event.details
          if (data.type === "server.connected") {
            resume()
            return
          }
          // The same person signed in again over a credential that was still valid. Its live updates stopped
          // with the old sign-in; the chat, its draft and its open references stay. Any other reset is the
          // window's, which every server's stream reaches: this page drops on its drop count, and its tab closes.
          if (data.type === "jolli.groupChat.reset") {
            if (data.properties.sameAccount === true) resume()
            return
          }
          if (
            !data.type.startsWith("jolli.groupChat.") ||
            !("chatID" in data.properties) ||
            data.properties.chatID !== current
          )
            return
          if (data.type === "jolli.groupChat.revoked") {
            loseAccess()
            return
          }
          if (data.type === "jolli.groupChat.changed") {
            void refresh()
            return
          }
          if (data.type === "jolli.groupChat.answer") {
            if (data.properties.reset) {
              answerStarts += 1
              setState({ stream: "", seq: -1, frameSeq: 0, truncatedAnswer: data.properties.truncated === true })
            }
            const frameSeq = data.properties.frameSeq
            if (typeof frameSeq === "number" && frameSeq <= state.frameSeq) return
            if (typeof frameSeq === "number") setState("frameSeq", frameSeq)
            if (data.properties.type !== "content_chunk" || !data.properties.content) return
            if (typeof data.properties.seq === "number" && data.properties.seq <= state.seq) return
            setState("seq", typeof data.properties.seq === "number" ? data.properties.seq : state.seq + 1)
            setState("stream", (text) => text + data.properties.content)
          }
        })
        const focus = () => {
          if (document.visibilityState !== "hidden") void refresh().then(markRead)
        }
        const clock = setInterval(() => {
          if (chat()?.access === "reader" && document.visibilityState !== "hidden") void refresh()
        }, 60_000)
        window.addEventListener("focus", focus)
        document.addEventListener("visibilitychange", focus)
        onCleanup(() => {
          live = false
          rewatch = undefined
          generation++
          follow.stop()
          stop()
          clearInterval(clock)
          clearTimeout(markRetry)
          window.removeEventListener("focus", focus)
          document.removeEventListener("visibilitychange", focus)
          void client.client.jolli
            .groupChatWatch({ chatID: current, clientID: client.clientID, active: false })
            .catch(() => undefined)
        })
      },
    ),
  )
  createEffect(() => {
    chat()?.messages.length
    chat()?.processing
    state.stream
    if (atBottom && scroller) {
      requestAnimationFrame(() => {
        scroller?.scrollTo({ top: scroller.scrollHeight })
        markRead()
      })
    }
  })
  const people = createMemo(
    () =>
      new Map(
        [...(chat()?.group.participants ?? []), ...(chat()?.group.formerPeople ?? [])].map((person) => [
          person.userId,
          person.name,
        ]),
      ),
  )
  /** Who the answer still being written is for, by name. */
  const running = createMemo(() => {
    const turn = runningGroupTurn(chat()?.group.turns, state.asking)
    if (!turn) return undefined
    return {
      agent: agentName(turn.assistantId) || language.t("groupChat.someAgent"),
      asker: people().get(turn.askerId) || language.t("groupChat.someone"),
    }
  })
  const answering = createMemo(() => {
    const turn = running()
    return turn
      ? language.t("groupChat.answeringFor", { agent: turn.agent, name: turn.asker })
      : language.t("groupChat.answering")
  })
  // Every way of following a link in the chat shows the full address first; the reference pane guards its own.
  onMount(() => {
    const element = scroller
    if (!element) return
    onCleanup(guardExternalLinks(element, { open: (url) => void openLink(url) }))
  })
  return (
    <div
      class="group-chat-workspace"
      classList={{ "group-chat-workspace-expanded": references.expanded && !!activeReference() }}
    >
      <section
        class="group-chat-page"
        data-testid="group-chat-page"
        onDragOver={(event) => {
          if (!event.dataTransfer?.types.includes("Files")) return
          event.preventDefault()
          event.dataTransfer.dropEffect = writable() ? "copy" : "none"
        }}
        onDrop={(event) => {
          if (!event.dataTransfer?.types.includes("Files")) return
          event.preventDefault()
          files(Array.from(event.dataTransfer.files))
        }}
      >
        <header class="group-chat-header">
          <div class="group-chat-heading">
            <div class="group-chat-mark" aria-hidden="true">
              <GroupChatIcon />
            </div>
            <div class="min-w-0">
              <div class="group-chat-course">{courseById(chat()?.courseId)?.code || language.t("groupChat.title")}</div>
              <h1 class="group-chat-title">{title()}</h1>
              <Show when={chat()?.access === "reader"}>
                <p class="group-chat-muted">{language.t("groupChat.shared")}</p>
              </Show>
            </div>
          </div>
          <div class="group-chat-header-actions">
            <span class="group-chat-server-badge" title={language.t("groupChat.boundary")}>
              {language.t("groupChat.server")}
            </span>
            <Show when={chat()}>
              {(value) => (
                <ButtonV2
                  disabled={offline()}
                  variant="ghost"
                  size="small"
                  onClick={() => {
                    // The page's own read rather than this Show's value, which goes stale once access is
                    // lost while the dialog is still closing.
                    const opened = value()
                    void dialog.show(() => (
                      <GroupChatPeopleDialog chat={chat() ?? opened} disabled={halted()} action={action} />
                    ))
                  }}
                >
                  {language.t("groupChat.members", { count: value().group.participants.length })}
                </ButtonV2>
              )}
            </Show>
            <Show
              when={
                chat() !== undefined &&
                chat()?.access !== "reader" &&
                chat()?.group.assignmentGroupId === undefined &&
                !chat()?.shareBlocked &&
                !halted()
              }
            >
              <ButtonV2
                variant="ghost"
                size="small"
                onClick={() => {
                  const value = chat()
                  if (value) void dialog.show(() => <GroupChatShareDialog chat={value} onAnswer={settle} />)
                }}
              >
                {language.t("groupChat.share")}
              </ButtonV2>
            </Show>
            <ButtonV2
              variant="ghost"
              size="small"
              aria-label={language.t("groupChat.refresh")}
              onClick={() => void refresh()}
            >
              {language.t("groupChat.refresh")}
            </ButtonV2>
          </div>
        </header>
        <Show when={offline()}>
          <div class="group-chat-banner" role="status">
            {language.t("groupChat.offline", {
              date: new Date(state.answer?.validatedAt ?? 0).toLocaleString(language.intl()),
            })}
            <Show when={state.answer?.truncated}>
              <span>{language.t("groupChat.truncated")}</span>
            </Show>
          </div>
        </Show>
        <Show when={state.refusal}>
          {(refusal) => (
            <div class="group-chat-banner" role="alert">
              {refusal().message ?? language.t(refusal().key)}
            </div>
          )}
        </Show>
        <Show when={state.failed}>
          <div class="group-chat-banner" role="alert">
            {language.t("groupChat.unavailable")}
          </div>
        </Show>
        <div
          class="group-chat-transcript"
          ref={scroller}
          onScroll={(event) => {
            const el = event.currentTarget
            atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48
            markRead()
          }}
        >
          <Show
            when={!state.loading}
            fallback={
              <div class="group-chat-empty" role="status">
                {language.t("groupChat.loading")}
              </div>
            }
          >
            <Show when={chat()}>
              <Show
                when={chat()?.messages.length || chat()?.processing || state.stream}
                fallback={
                  <div class="group-chat-empty">
                    <div class="group-chat-empty-mark">
                      <GroupChatIcon />
                    </div>
                    <h2>{language.t("groupChat.empty")}</h2>
                    <p>{language.t("groupChat.emptyHint")}</p>
                  </div>
                }
              >
                <div class="group-chat-message-list" role="log" aria-label={language.t("groupChat.title")}>
                  <For each={chat()?.messages ?? []}>
                    {(message) => {
                      const turn = () => chat()?.group.turns?.find((turn) => turn.turnId === message.turnId)
                      const data = createMemo(() => groupMessagePayload(message.payload))
                      const author = () =>
                        message.role === "assistant"
                          ? agentName(turn()?.assistantId ?? null) || language.t("groupChat.agents")
                          : people().get(message.authorId ?? -1) || language.t("groupChat.people")
                      const own = () => message.authorId !== undefined && message.authorId === chat()?.viewerId
                      // The asked agent of a person's message, by name.
                      const sentTo = () => {
                        const assistantId = message.role === "user" ? turn()?.assistantId : null
                        if (assistantId === undefined || assistantId === null) return undefined
                        return agentName(assistantId) || language.t("groupChat.someAgent")
                      }
                      const mentions = () =>
                        message.role !== "user"
                          ? []
                          : [
                              ...data().mentions.userIds.flatMap((userId) => {
                                const name = people().get(userId)
                                return name ? [`@${name}`] : []
                              }),
                              ...(data().mentions.all ? ["@all"] : []),
                            ]
                      // Every stored answer is finished, so its aliases read as names; only the live bubble keeps them.
                      const text = () =>
                        message.role === "assistant"
                          ? replaceAliases(message.content, chat()?.group.aliases ?? [], people())
                          : systemText(message)
                      return (
                        <article
                          class="group-chat-message"
                          classList={{
                            "group-chat-message-own": own(),
                            "group-chat-message-agent": message.role === "assistant",
                            "group-chat-message-system": message.role === "system",
                          }}
                          data-seq={message.seq}
                        >
                          <div class="group-chat-message-avatar" aria-hidden="true">
                            {message.role === "assistant" ? <GroupAgentIcon /> : author().slice(0, 2)}
                          </div>
                          <div class="group-chat-message-body">
                            <div class="group-chat-message-meta">
                              <strong>{author()}</strong>
                              <Show when={sentTo()}>
                                {(agent) => (
                                  <span class="group-chat-sent-to">
                                    {language.t("groupChat.sentTo", { agent: agent() })}
                                  </span>
                                )}
                              </Show>
                              <For each={mentions()}>
                                {(mention) => <span class="group-chat-mention">{mention}</span>}
                              </For>
                              <Show when={message.role === "assistant" && turn()}>
                                {(answered) => (
                                  <span>
                                    {language.t("groupChat.answeringPerson", {
                                      name: people().get(answered().askerId) ?? language.t("groupChat.someone"),
                                    })}
                                  </span>
                                )}
                              </Show>
                              <time dateTime={message.timestamp}>
                                {new Date(message.timestamp).toLocaleTimeString(language.intl(), {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                })}
                              </time>
                            </div>
                            <div class="group-chat-message-content">
                              <Markdown text={text()} untrusted />
                              <Show when={message.role === "assistant" && data().studioArtifact}>
                                {(artifact) => (
                                  <GroupChatArtifactCard
                                    sdk={sdk()}
                                    chatID={id()}
                                    artifactId={artifact().id}
                                    onOpen={openReference}
                                    onSignedOut={signOut}
                                  />
                                )}
                              </Show>
                              <Show when={sources().get(message.id)}>
                                {(references) => (
                                  <GroupChatSources
                                    sources={references()}
                                    chat={chat()!}
                                    staff={staff()}
                                    onOpen={(source, trigger, url) => {
                                      const preview = referencePreviewOf(source, chat()!, staff())
                                      if (preview) return openReference(preview, trigger)
                                      void openLink(url)
                                    }}
                                  />
                                )}
                              </Show>
                              <div class="group-chat-file-tray">
                                <For each={data().attachments}>
                                  {(attachment) => (
                                    <div class="group-chat-file-chip">
                                      <button
                                        type="button"
                                        aria-label={language.t("groupChat.preview.open")}
                                        onClick={(event) =>
                                          openReference(
                                            {
                                              key: `attachment:${attachment.attachmentId}`,
                                              title: attachment.filename,
                                              reference: { kind: "attachment", attachmentId: attachment.attachmentId },
                                            },
                                            event.currentTarget,
                                          )
                                        }
                                      >
                                        {attachment.filename}
                                      </button>
                                      <button
                                        type="button"
                                        class="reference-icon-button"
                                        aria-label={language.t("groupChat.download")}
                                        onClick={() => download(attachment)}
                                      >
                                        ↓
                                      </button>
                                    </div>
                                  )}
                                </For>
                                <For each={data().pinnedMaterials}>
                                  {(material) => (
                                    <button
                                      type="button"
                                      class="group-chat-file-chip"
                                      disabled={
                                        material.downloadable === false || material.unavailable || !chat()?.webBaseUrl
                                      }
                                      onClick={() => openMaterial(material.materialId, material.title)}
                                    >
                                      {material.title}
                                    </button>
                                  )}
                                </For>
                              </div>
                            </div>
                            <Show
                              when={
                                message.role === "assistant" &&
                                !message.incomplete &&
                                features.capabilities.readAloud &&
                                !offline()
                              }
                            >
                              <ButtonV2
                                variant="ghost"
                                size="small"
                                disabled={voice.state.mode !== "idle" && voice.state.playingId !== message.id}
                                onClick={() =>
                                  void (voice.state.playingId === message.id ? voice.stop() : voice.play(message.id))
                                }
                              >
                                {language.t(
                                  voice.state.playingId === message.id ? "groupChat.stopAloud" : "groupChat.readAloud",
                                )}
                              </ButtonV2>
                            </Show>
                          </div>
                        </article>
                      )
                    }}
                  </For>
                  <Show when={chat()?.processing || state.stream}>
                    <article
                      class="group-chat-message group-chat-message-agent group-chat-message-pending"
                      data-testid="group-chat-pending-answer"
                    >
                      <div class="group-chat-message-avatar" aria-hidden="true">
                        <GroupAgentIcon />
                      </div>
                      <div class="group-chat-message-body">
                        <div class="group-chat-message-meta">
                          <span class="group-chat-answer-label" title={answering()} role="status">
                            {answering()}
                          </span>
                          <span class="group-chat-typing" aria-hidden="true">
                            <span />
                            <span />
                            <span />
                          </span>
                          <Show when={!halted() && canStopGroupAnswer(chat(), state.asking)}>
                            <ButtonV2
                              variant="ghost"
                              size="small"
                              class="group-chat-stop"
                              disabled={state.stopping}
                              aria-busy={state.stopping}
                              data-testid="group-chat-stop-answer"
                              onClick={() => void stopAnswer()}
                            >
                              <Icon name="stop" />
                              {language.t("prompt.action.stop")}
                            </ButtonV2>
                          </Show>
                        </div>
                        <Show when={state.truncatedAnswer}>
                          <p class="group-chat-muted">{language.t("groupChat.partialAnswer")}</p>
                        </Show>
                        <Show when={state.stream}>
                          <Markdown text={state.stream} streaming untrusted />
                        </Show>
                      </div>
                    </article>
                  </Show>
                </div>
              </Show>
            </Show>
          </Show>
        </div>
        <footer class="group-chat-dock">
          <Show when={voice.state.error}>
            {(error) => (
              <p class="group-chat-error" role="alert">
                {language.t(
                  error() === "permission"
                    ? "groupChat.voicePermission"
                    : error() === "refresh"
                      ? "groupChat.readAgain"
                      : "groupChat.voiceFailed",
                )}
              </p>
            )}
          </Show>
          <Show when={chat()}>
            {(value) => (
              <Show
                when={value().access !== "reader" && !value().locked}
                fallback={
                  <p class="group-chat-readonly">
                    {language.t(value().locked ? "groupChat.locked" : "groupChat.readOnly")}
                  </p>
                }
              >
                <Show when={pausedTarget() !== undefined}>
                  <p class="group-chat-boundary" role="status">
                    {pausedTarget()
                      ? language.t("groupChat.targetPaused", { agent: pausedTarget()! })
                      : language.t("groupChat.targetPausedUnnamed")}
                  </p>
                </Show>
                <GroupChatComposer
                  chat={value()}
                  draft={draft()}
                  disabled={halted()}
                  sendDisabled={!attachments.ready()}
                  locked={voice.state.mode === "recording" || voice.state.mode === "transcribing"}
                  onPasteFiles={files}
                  onAttach={pick}
                  onMaterials={() =>
                    void dialog.show(() => (
                      <GroupChatMaterialsDialog
                        courseId={value().courseId}
                        selected={attachments.materialIds()}
                        onPin={(material) => attachments.pin(material)}
                      />
                    ))
                  }
                  onDictate={
                    features.capabilities.input
                      ? () =>
                          void dialog.show(() => (
                            <GroupChatConfirmation
                              title={language.t("groupChat.dictate")}
                              detail={language.t("groupChat.voiceNotice")}
                              confirm={language.t("groupChat.continue")}
                              onConfirm={() => void voice.record()}
                            />
                          ))
                      : undefined
                  }
                  features={features.capabilities}
                  featuresLoading={features.status.loading}
                  onReloadFeatures={() => void features.load()}
                  target={remembered()}
                  onTarget={chooseTarget}
                  running={running()}
                  attachmentIds={attachments.ids()}
                  pinnedMaterialIds={attachments.materialIds()}
                  post={post}
                >
                  <div class="group-chat-file-tray">
                    <For each={attachments.state.files}>
                      {(chip) => (
                        <div class="group-chat-file-chip" classList={{ "group-chat-file-chip-failed": chip.failed }}>
                          <span class="truncate">{chip.name}</span>
                          <span>{chip.failed ? language.t("groupChat.uploadFailed") : `${chip.progress}%`}</span>
                          <button
                            type="button"
                            aria-label={language.t("groupChat.remove")}
                            onClick={() => attachments.remove(chip.key)}
                          >
                            ×
                          </button>
                        </div>
                      )}
                    </For>
                    <For each={attachments.state.materials}>
                      {(material) => (
                        <div class="group-chat-file-chip">
                          <span class="truncate">{material.title}</span>
                          <button
                            type="button"
                            aria-label={language.t("groupChat.remove")}
                            onClick={() => attachments.unpin(material.id)}
                          >
                            ×
                          </button>
                        </div>
                      )}
                    </For>
                  </div>
                  <input
                    ref={picker}
                    type="file"
                    multiple
                    class="hidden"
                    onChange={(event) => {
                      files(Array.from(event.currentTarget.files ?? []))
                      event.currentTarget.value = ""
                    }}
                  />
                  <Show when={voice.state.mode === "recording" || voice.state.mode === "transcribing"}>
                    <div class="group-chat-busy" role="status">
                      <span>
                        {language.t(
                          voice.state.mode === "recording" ? "groupChat.recording" : "groupChat.transcribing",
                        )}
                      </span>
                      <ButtonV2
                        variant="outline"
                        size="small"
                        onClick={() => (voice.state.mode === "recording" ? void voice.finish() : void voice.stop())}
                      >
                        {language.t(voice.state.mode === "recording" ? "groupChat.stopRecording" : "groupChat.cancel")}
                      </ButtonV2>
                    </div>
                  </Show>
                  <Show when={attachments.state.error}>
                    <p class="group-chat-error" role="alert">
                      {language.t("groupChat.fileLimit")}
                    </p>
                  </Show>
                </GroupChatComposer>
              </Show>
            )}
          </Show>
        </footer>
      </section>
      <Show when={activeReference()}>
        {(active) => (
          <ReferenceDock
            sdk={sdk()}
            target={active().target ?? { kind: "group", chatID: id() }}
            items={references.items}
            active={active()}
            opening={references.opening}
            expanded={references.expanded}
            width={references.width}
            onActivate={(item) => openReference(item)}
            onClose={closeReference}
            onOpen={openReference}
            onExpand={() => setReferences("expanded", !references.expanded)}
            onResize={(width) => setReferences("width", width)}
            onSignedOut={signOut}
          />
        )}
      </Show>
    </div>
  )
}

function GroupAgentIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="m10 2 2.2 5.8L18 10l-5.8 2.2L10 18l-2.2-5.8L2 10l5.8-2.2L10 2Z"
        stroke="currentColor"
        stroke-width="1.4"
        stroke-linejoin="round"
      />
    </svg>
  )
}
