import { ImagePreview } from "@opencode-ai/ui/image-preview"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { KeybindV2 } from "@opencode-ai/ui/v2/keybind-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import type { ReferenceInfo } from "@opencode-ai/sdk/v2/client"
import { createEffect, createMemo, on, Show, type JSX } from "solid-js"
import { ModelSelectorPopoverV2 } from "@/components/dialog-select-model"
import { PromptPrivacyControl } from "@/components/prompt-privacy-control"
import { SessionCourseBar } from "@/components/session/session-course-bar"
import { groupSlashCommands } from "@/jolli/slash-groups"
import { useCourseSession } from "@/jolli/session-binding"
import { ModelGrant } from "@/jolli/model-grant"
import type { PromptInputProps } from "@/components/prompt-input/contracts"
import { normalizePromptHistoryEntry, promptLength, type PromptHistoryComment } from "@/components/prompt-input/history"
import { createPersistedPromptInputHistory } from "@/components/prompt-input/history-store"
import { promptDesignPlaceholder, promptPlaceholder } from "@/components/prompt-input/placeholder"
import { createPromptSubmit } from "@/components/prompt-input/submit"
import { selectionFromLines, type SelectedLineRange, useFile } from "@/context/file"
import { useComments } from "@/context/comments"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { usePermission } from "@/context/permission"
import { type ImageAttachmentPart, usePrompt } from "@/context/prompt"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { createSessionTabs } from "@/pages/session/helpers"
import { showToast } from "@/utils/toast"
import { PromptInputV2, type PromptInputV2Suggestion } from "@opencode-ai/session-ui/v2/prompt-input"
import {
  createPromptInputV2Controller,
  createPromptInputV2State,
  type PromptInputV2Interaction,
} from "@opencode-ai/session-ui/v2/prompt-input/interaction"

export type PromptInputV2ComposerProps = {
  class?: string
  controller: PromptInputV2ComposerController
  borderUnderlay?: boolean
  /**
   * APPENDED TO THE COURSE ROW ABOVE THE BOX, AFTER THE ASSISTANT — see `SessionCourseBar`.
   *
   * ⚠ A SLOT BECAUSE ONLY ONE SCREEN HAS ANYTHING TO PUT IN IT. The project and workspace selectors
   * are the draft screen's, and their controllers live on that route; a live session has no project
   * control at all and passes nothing.
   */
  courseBarTrailing?: JSX.Element
}

export type PromptInputV2ControllerProps = Omit<PromptInputProps, "class" | "submission">
export type PromptInputV2ComposerController = PromptInputV2Interaction & {
  readonly model: PromptInputProps["controls"]["model"]
}

export function PromptInputV2Composer(props: PromptInputV2ComposerProps) {
  const dialog = useDialog()
  const command = useCommand()
  const language = useLanguage()
  const courseSession = useCourseSession()

  /**
   * A LIVE SESSION (has an id) THAT CARRIES NO COURSE: one from the CLI/server, a pre-rebrand
   * session, or one whose binding was lost when localStorage was cleared. There is no course picker
   * on this screen to bind one in place — course is chosen only when a session starts — so the notice
   * below is the exit rather than a dead, un-sendable composer.
   */
  const unboundLive = () => courseSession.locked() && !courseSession.course()

  return (
    <div class="flex flex-col gap-3">
      <Show when={unboundLive()}>
        <div
          data-component="session-no-course-notice"
          class="flex items-center gap-2 rounded-xl bg-v2-background-bg-base px-3 py-2 text-[13px] leading-5 text-v2-text-text-muted shadow-[var(--v2-elevation-raised)]"
        >
          <Icon name="help" class="shrink-0 text-v2-icon-icon-info" />
          <span class="min-w-0 flex-1">{language.t("prompt.session.noCourse.notice")}</span>
          <ButtonV2
            variant="neutral"
            size="normal"
            data-action="session-no-course-new"
            onClick={() => command.trigger("session.new")}
          >
            {language.t("prompt.session.noCourse.new")}
          </ButtonV2>
        </div>
      </Show>
      {/*
       * WHICH COURSE AND ASSISTANT, DIRECTLY ABOVE THE BOX.
       *
       * ⚠ HERE RATHER THAN ON EITHER SCREEN, BECAUSE BOTH SCREENS RENDER THIS COMPONENT. The draft
       * route and a live session mount `PromptInputV2Composer` from completely different frames, so
       * this is the only place the bar can sit and be in the same position on both — and the only
       * one that cannot go stale when one of those frames is next rewritten.
       *
       * ⚠ AND IT IS THE LAST THING BEFORE THE INPUT, BELOW THE NO-COURSE NOTICE ABOVE. Everything
       * the composer region stacks over the box — question, permission, todo, revert, followup
       * docks — is transient; the binding is a fact about the session, so it stays glued to the
       * input at a fixed distance whatever else appears.
       *
       * ⚠ IT ALSO CARRIES WHATEVER THE SCREEN PUT IN `courseBarTrailing` — on the draft route, the
       * project and workspace selectors that used to sit under the box.
       */}
      <SessionCourseBar onDone={props.controller.restoreFocus} trailing={props.courseBarTrailing} />
      <PromptInputV2
        controller={props.controller}
        borderUnderlay={props.borderUnderlay}
        class={props.class}
        /**
         * ⚠ NO COURSE, NO SEND — ON EVERY SCREEN. Nothing is pre-selected on a new session, and a
         * session created without a binding is one no screen can describe: no assistant to run, no
         * model grant, no visibility, and an in-chat header with nothing in it. The guard is
         * `!course()` alone, so it holds on the new-session screen AND on a live session that never
         * got one. It gates every send path — see `submitDisabled` handling in `session-ui`'s
         * prompt-input (button, form submit, and Enter all honour it), so it cannot be keyboard-bypassed.
         *
         * ⚠ A LIVE SESSION WITH NO COURSE IS BLOCKED, NOT TRAPPED. It has no course control on screen
         * to fix the binding in place, so the `unboundLive` notice above hands the reader a new
         * session — the one screen where a course can be chosen — rather than leaving them stuck.
         */
        submitDisabled={!courseSession.course()}
        variantControlVisible={!props.controller.model.loading}
        attachKeybind={command.keybindParts("file.attach")}
        attachShortcut={command.keybind("file.attach")}
        privacyControl={<PromptPrivacyControl />}
        modelControl={
          <PromptInputV2ModelControl
            loading={props.controller.model.loading}
            title={language.t("command.model.choose")}
            keybind={command.keybindParts("model.choose")}
            model={props.controller.model.selection}
            providerID={props.controller.model.selection.current()?.provider?.id}
            modelName={props.controller.model.selection.current()?.name ?? language.t("dialog.model.select.title")}
            unboundLabel={language.t("prompt.model.noCourse")}
            onClose={props.controller.restoreFocus}
          />
        }
      />
    </div>
  )
}

export function usePromptInputV2Controller(props: PromptInputV2ControllerProps): PromptInputV2ComposerController {
  const sdk = useSDK()
  const sync = useSync()
  const files = useFile()
  const layout = useLayout()
  const comments = useComments()
  const dialog = useDialog()
  const command = useCommand()
  const permission = usePermission()
  const language = useLanguage()
  const platform = usePlatform()
  const courseSession = useCourseSession()
  const prompt = props.state ?? usePrompt()
  let editor: HTMLDivElement | undefined

  const interaction = createPromptInputV2State()
  const mode = () => interaction[0].mode
  const history = props.history ?? createPersistedPromptInputHistory()
  const tabs = () => props.controls.session.tabs
  const activeFileTab = createSessionTabs({
    tabs,
    pathFromTab: files.pathFromTab,
    normalizeTab: (tab) => (tab.startsWith("file://") ? files.tab(tab) : tab),
  }).activeFileTab
  const recent = createMemo(() => {
    const all = tabs().all()
    const active = activeFileTab()
    const order = active ? [active, ...all.filter((tab) => tab !== active)] : all
    return order.reduce<string[]>((result, tab) => {
      const path = files.pathFromTab(tab)
      if (!path || result.includes(path)) return result
      return [...result, path]
    }, [])
  })
  const info = createMemo(() => (props.controls.session.id ? sync().session.get(props.controls.session.id) : undefined))
  const working = createMemo(() => sync().data.session_working(props.controls.session.id ?? ""))
  const attachments = createMemo(() =>
    prompt.current().filter((part): part is ImageAttachmentPart => part.type === "image"),
  )
  const commentCount = createMemo(() => {
    if (mode() === "shell") return 0
    return prompt.context.items().filter((item) => !!item.comment?.trim()).length
  })
  const blank = createMemo(() => {
    const text = prompt
      .current()
      .map((part) => ("content" in part ? part.content : ""))
      .join("")
    return text.trim().length === 0 && attachments().length === 0 && commentCount() === 0
  })
  const stopping = createMemo(() => working() && blank())
  const placeholder = createMemo(() =>
    promptPlaceholder({
      mode: mode(),
      commentCount: commentCount(),
      example: mode() === "shell" ? "git status" : "",
      suggest: false,
      t: (key, params) => language.t(key as Parameters<typeof language.t>[0], params as never),
    }),
  )
  const designPlaceholder = () =>
    promptDesignPlaceholder(mode(), placeholder(), (key, params) =>
      language.t(key as Parameters<typeof language.t>[0], params as never),
    )

  const historyComments = () => {
    const byID = new Map(comments.all().map((item) => [`${item.file}\n${item.id}`, item] as const))
    return prompt.context.items().flatMap((item) => {
      const comment = item.comment?.trim()
      if (!comment) return []
      const selection = item.commentID ? byID.get(`${item.path}\n${item.commentID}`)?.selection : undefined
      const nextSelection =
        selection ??
        (item.selection
          ? ({ start: item.selection.startLine, end: item.selection.endLine } satisfies SelectedLineRange)
          : undefined)
      if (!nextSelection) return []
      return [
        {
          id: item.commentID ?? item.key,
          path: item.path,
          selection: { ...nextSelection },
          comment,
          time: item.commentID ? (byID.get(`${item.path}\n${item.commentID}`)?.time ?? Date.now()) : Date.now(),
          origin: item.commentOrigin,
          preview: item.preview,
        } satisfies PromptHistoryComment,
      ]
    })
  }
  const restoreHistoryComments = (items: PromptHistoryComment[]) => {
    comments.replace(
      items.map((item) => ({
        id: item.id,
        file: item.path,
        selection: { ...item.selection },
        comment: item.comment,
        time: item.time,
      })),
    )
    prompt.context.replaceComments(
      items.map((item) => ({
        type: "file",
        path: item.path,
        selection: selectionFromLines(item.selection),
        comment: item.comment,
        commentID: item.id,
        commentOrigin: item.origin,
        preview: item.preview,
      })),
    )
  }

  const accepting = createMemo(() => {
    const id = props.controls.session.id
    if (!id) return permission.isAutoAcceptingDirectory(sdk().directory)
    return permission.isAutoAccepting(id, sdk().directory)
  })
  const submission = createPromptSubmit({
    prompt,
    info,
    imageAttachments: attachments,
    commentCount,
    autoAccept: accepting,
    mode,
    working,
    editor: () => editor,
    queueScroll: () => requestAnimationFrame(() => editor?.scrollIntoView({ block: "nearest" })),
    promptLength,
    addToHistory: (value, mode) => controller.addHistory(value, mode),
    resetHistoryNavigation: () => controller.resetHistory(),
    setMode: (next) => controller.dispatch({ type: next === "shell" ? "mode.shell" : "mode.normal" }),
    setPopover: (popover) => {
      if (!popover) controller.dispatch({ type: "popover.close" })
    },
    newSessionWorktree: () => props.newSessionWorktree,
    onNewSessionWorktreeReset: props.onNewSessionWorktreeReset,
    shouldQueue: props.shouldQueue,
    onQueue: props.onQueue,
    onAbort: props.onAbort,
    onSubmit: props.onSubmit,
    model: props.controls.model.selection,
  })

  const referenceDescription = (reference: ReferenceInfo) =>
    reference.source.type === "git" ? reference.source.repository : reference.source.path
  const references = createMemo(() =>
    sync()
      .data.reference.filter((reference) => !reference.hidden)
      .map((reference) => ({
        id: `reference:${reference.name}`,
        kind: "reference" as const,
        label: `@${reference.name}`,
        path: reference.path,
        description: reference.description ?? referenceDescription(reference),
        mention: {
          type: "file" as const,
          path: reference.path,
          content: `@${reference.name}`,
          start: 0,
          end: 0,
          mime: "application/x-directory",
          filename: reference.name,
        },
      })),
  )
  const resources = createMemo(() =>
    Object.values(sync().data.mcp_resource).map((resource) => ({
      id: `resource:${resource.server}:${resource.uri}`,
      kind: "resource" as const,
      label: `@${resource.name}`,
      path: resource.uri,
      description: resource.description,
      mention: {
        type: "file" as const,
        path: resource.uri,
        content: `@${resource.name}`,
        start: 0,
        end: 0,
        mime: resource.mimeType ?? "text/plain",
        filename: resource.name,
        url: resource.uri,
        source: {
          type: "resource" as const,
          text: { value: `@${resource.name}`, start: 0, end: resource.name.length + 1 },
          clientName: resource.server,
          uri: resource.uri,
        },
      },
      resource,
    })),
  )
  const context = createMemo<PromptInputV2Suggestion[]>(() => [
    ...references(),
    ...props.controls.agents.available
      .filter((agent) => !agent.hidden && agent.mode !== "primary")
      .map((agent) => ({
        id: `agent:${agent.name}`,
        kind: "agent" as const,
        label: `@${agent.name}`,
        mention: { type: "agent" as const, name: agent.name, content: `@${agent.name}`, start: 0, end: 0 },
      })),
    ...resources(),
    ...recent().map((path) => ({
      id: `file:${path}`,
      kind: "file" as const,
      label: path,
      path,
      recent: true,
      mention: { type: "file" as const, path, content: `@${path}`, start: 0, end: 0 },
    })),
  ])
  /**
   * THE SLASH LIST, WITH THE COURSE'S OWN PROCEDURES LIFTED TO THE TOP UNDER THE ASSISTANT'S NAME.
   * Upstream's order is [custom, builtin] and stays that way inside each group; `slash-groups.ts`
   * owns the reordering and says there why ownership is decided by `skillId` rather than by the
   * server's `source: "skill"`, and why a list with no course procedures in it gets no headers.
   */
  const slashCommands = createMemo(() =>
    groupSlashCommands(
      [
        ...sync().data.command.map((item) => ({
          id: `custom.${item.name}`,
          trigger: item.name,
          title: item.name,
          description: item.description,
          type: "custom" as const,
        })),
        ...command.options
          .filter((item) => !item.disabled && !item.id.startsWith("suggested.") && item.slash)
          .map((item) => ({
            id: item.id,
            trigger: item.slash!,
            title: item.title,
            description: item.description,
            type: "builtin" as const,
          })),
      ],
      courseSession.assistant(),
    ),
  )
  const commands = createMemo<PromptInputV2Suggestion[]>(() =>
    slashCommands().map((item) => ({
      id: item.id,
      kind: "command",
      label: `/${item.trigger}`,
      trigger: item.trigger,
      title: item.title,
      description: item.description,
      group: item.group,
      keybind: command.keybindParts(item.id),
    })),
  )
  const variants = createMemo(() => ["default", ...props.controls.model.selection.variant.list()])
  const controller = createPromptInputV2Controller({
    store: () => prompt.capture().store,
    state: interaction,
    identity: () => prompt.capture(),
    history: {
      entries: (mode) =>
        history.entries(mode).map((value) => {
          const entry = normalizePromptHistoryEntry(value)
          return { prompt: entry.prompt, metadata: entry.comments }
        }),
      add: (value, mode) => history.add(value, mode, mode === "shell" ? [] : historyComments()),
      capture: historyComments,
      restore: (metadata) => restoreHistoryComments(metadata as PromptHistoryComment[]),
    },
    commands,
    context,
    searchContextFiles: async (query) =>
      (await files.searchFilesAndDirectories(query)).map((path) => ({
        id: `file:${path}`,
        kind: "file",
        label: path,
        path,
        mention: { type: "file", path, content: `@${path}`, start: 0, end: 0 },
      })),
    onContextRemove(item) {
      if (item?.commentID) comments.remove(item.path, item.commentID)
    },
    openAttachment: (attachment) =>
      dialog.show(() => <ImagePreview src={attachment.blob.url} alt={attachment.filename} />),
    openContext(key) {
      const item = controller.contextItem(key)
      if (item) openComment(item, props, sync, layout, files, comments)
    },
    onEditor(element) {
      editor = element as HTMLDivElement
      props.ref?.(editor)
    },
    onSuggestionSelect(item) {
      if (item.kind !== "command") return
      const selected = slashCommands().find((entry) => entry.id === item.id)
      if (!selected || selected.type === "custom") return
      return () => command.trigger(selected.id, "slash")
    },
    attachments: {
      picker: platform.openAttachmentPickerDialog,
      directory: () => sdk().directory,
      isDialogActive: () => !!dialog.active,
      warn: () =>
        showToast({
          title: language.t("prompt.toast.pasteUnsupported.title"),
          description: language.t("prompt.toast.pasteUnsupported.description"),
        }),
      duplicate: () => showToast({ title: language.t("prompt.toast.attachmentDuplicate.title") }),
      onError: (error) =>
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: error instanceof Error ? error.message : String(error),
        }),
      readClipboardImage: platform.readClipboardImage,
      getPathForFile: platform.getPathForFile,
      store: platform.draftStore?.putBlob,
    },
    view: {
      placeholder: designPlaceholder,
      get agent() {
        /**
         * ⚠ THE AGENT CHIP IS THE ASSISTANT PICKER, AND A COURSE-BOUND SESSION MUST NOT OFFER IT.
         * The assistant is chosen once, on the new-session screen, and carries the professor's
         * instructions and guardrails; letting a student cycle agents mid-session would swap those
         * out from under a session already scoped to them.
         *
         * ⚠ HIDDEN ONLY WHERE A COURSE IS ACTUALLY BOUND, so an unbound session behaves exactly
         * like upstream rather than losing a control for no stated reason.
         */
        if (courseSession.course()) return undefined
        return props.controls.agents.visible && props.controls.agents.options.length > 0
          ? {
              options: () => props.controls.agents.options.map((name) => ({ id: name, label: name })),
              current: () => props.controls.agents.current,
              onSelect: (value: string) => props.controls.agents.select(value),
              keybind: () => command.keybindParts("agent.cycle"),
            }
          : undefined
      },
      variant: {
        options: () => variants().map((value) => ({ id: value, label: value })),
        current: () => props.controls.model.selection.variant.current() ?? "default",
        onSelect: (value) => props.controls.model.selection.variant.set(value === "default" ? undefined : value),
        keybind: () => command.keybindParts("model.variant.cycle"),
      },
      submit: {
        stopping,
        working,
        onSubmit: () => void submission.handleSubmit(new Event("submit")),
        onStop: () => void submission.abort(),
      },
    },
  })
  Object.defineProperty(controller, "model", { get: () => props.controls.model })

  command.register("prompt-input", () => [
    {
      id: "file.attach",
      title: language.t("prompt.action.attachFile"),
      category: language.t("command.category.file"),
      keybind: "mod+u",
      disabled: controller.state.mode !== "normal",
      onSelect: () => controller.attach(),
    },
    {
      id: "prompt.mode.shell",
      title: language.t("command.prompt.mode.shell"),
      category: language.t("command.category.session"),
      keybind: "mod+shift+x",
      disabled: controller.state.mode === "shell",
      onSelect: () => controller.dispatch({ type: "mode.shell" }),
    },
    {
      id: "prompt.mode.normal",
      title: language.t("command.prompt.mode.normal"),
      category: language.t("command.category.session"),
      keybind: "mod+shift+e",
      disabled: controller.state.mode === "normal",
      onSelect: () => controller.dispatch({ type: "mode.normal" }),
    },
  ])

  createEffect(
    on(
      () => props.edit?.id,
      (id) => {
        const edit = props.edit
        if (!id || !edit) return
        prompt.context.items().forEach((item) => prompt.context.remove(item.key))
        edit.context.forEach((item) =>
          prompt.context.add({
            type: item.type,
            path: item.path,
            selection: item.selection,
            comment: item.comment,
            commentID: item.commentID,
            commentOrigin: item.commentOrigin,
            preview: item.preview,
          }),
        )
        controller.dispatch({ type: "mode.normal" })
        controller.resetHistory()
        prompt.set(edit.prompt, promptLength(edit.prompt))
        controller.restoreFocus()
        props.onEditLoaded?.()
      },
      { defer: true },
    ),
  )

  return controller as PromptInputV2ComposerController
}

function PromptInputV2ModelControl(props: {
  loading: boolean
  title: string
  keybind: string[]
  model: PromptInputV2ComposerController["model"]["selection"]
  providerID?: string
  modelName: string
  /** Shown greyed when no course is chosen: naming a model there would credit a course decision. */
  unboundLabel: string
  onClose: () => void
}) {
  const shouldAnimate = createMemo<boolean>((previous) => previous ?? props.loading)
  const content = () => (
    <>
      <Show when={props.providerID}>
        {(providerID) => (
          <ProviderIcon
            id={providerID()}
            class="size-4 shrink-0 opacity-40 group-hover:opacity-100 transition-opacity duration-150"
            style={{ "will-change": "opacity", transform: "translateZ(0)" }}
          />
        )}
      </Show>
      <span class="truncate leading-4">{props.modelName}</span>
      <span class="-ml-0.5 -mr-1 flex shrink-0">
        <Icon name="chevron-down" />
      </span>
    </>
  )
  /**
   * ⚠ NO CONTROL WHERE THE COURSE LEFT NO CHOICE. Ported from the web mock's rule verbatim
   * (`RecipientComposer.tsx`): "fewer than two allowed is not a choice, so it renders nothing rather
   * than a control with one option". A professor who pinned one model has decided; a disabled chip
   * repeating that decision on every screen is furniture, and a live-looking one invites a click
   * that cannot do anything.
   *
   * ⚠ AN EMPTY GRANT IS "ALL", NOT "NONE", so an unrestricted assistant keeps its picker — see
   * `jolli/model-grant.ts`. The provider list behind it is already only Jolli's, because the server
   * is started with a config that enables one provider (`desktop/src/main/jolli-gateway.ts`), so
   * "all" here can never mean somebody's own API key.
   */
  const pickable = () => ModelGrant.allowed().length !== 1
  /**
   * ⚠ GREYED, NOT HIDDEN, BEFORE A COURSE IS CHOSEN. With no assistant there is no grant, and an
   * ungranted picker would offer the institution's whole catalogue — the one list this product
   * exists to not show. Hiding it instead would move the composer's controls sideways the moment a
   * course is picked, on the screen where the reader is choosing one.
   */
  const bound = () => ModelGrant.bound()
  return (
    <Show when={!props.loading && pickable()}>
      <TooltipV2
        placement="top"
        gutter={4}
        value={
          <>
            {props.title}
            <KeybindV2 keys={props.keybind} variant="neutral" />
          </>
        }
      >
        {/*
         * ⚠ NO "UNPAID" BRANCH. Upstream swaps the picker for a button that opens a dialog offering
         * OpenCode's free models and a grid of providers to connect, whenever no paid provider is
         * connected. There is nothing for a student to connect and no second catalogue to offer, so
         * the branch is gone rather than left to a condition the gateway config happens to satisfy.
         */}
        <Show
          when={bound()}
          fallback={
            <ButtonV2
              variant="ghost-muted"
              size="normal"
              style={{ height: "28px" }}
              class="min-w-0 max-w-[220px] justify-start ![font-weight:440] group"
              data-action="prompt-model"
              disabled
            >
              {/* The placeholder, not the resolved model: with no course there is no course decision
                  to name, and showing one would credit a professor with a choice nobody made. */}
              <span class="truncate leading-4">{props.unboundLabel}</span>
              <span class="-ml-0.5 -mr-1 flex shrink-0">
                <Icon name="chevron-down" />
              </span>
            </ButtonV2>
          }
        >
          <ModelSelectorPopoverV2
            model={props.model}
            trigger={(triggerProps) => (
              <ButtonV2
                {...triggerProps}
                variant="ghost-muted"
                size="normal"
                style={{ height: "28px" }}
                class="min-w-0 max-w-[220px] justify-start ![font-weight:440] group"
                classList={{ "animate-in fade-in": shouldAnimate() }}
                data-action="prompt-model"
                data-control-type="popover"
              >
                {content()}
              </ButtonV2>
            )}
            onClose={props.onClose}
          />
        </Show>
      </TooltipV2>
    </Show>
  )
}

function openComment(
  item: { path: string; commentID?: string; commentOrigin?: "review" | "file" },
  props: PromptInputV2ControllerProps,
  sync: ReturnType<typeof useSync>,
  layout: ReturnType<typeof useLayout>,
  files: ReturnType<typeof useFile>,
  comments: ReturnType<typeof useComments>,
) {
  if (!item.commentID) return
  const focus = { file: item.path, id: item.commentID }
  comments.setActive(focus)
  const queueFocus = (attempts = 6) => {
    requestAnimationFrame(() => {
      comments.setFocus({ ...focus })
      if (attempts <= 0) return
      requestAnimationFrame(() => {
        const current = comments.focus()
        if (current?.file === focus.file && current.id === focus.id) queueFocus(attempts - 1)
      })
    })
  }
  const diffs = props.controls.session.id ? sync().data.session_diff[props.controls.session.id] : undefined
  const review =
    item.commentOrigin === "review" || (item.commentOrigin !== "file" && diffs?.some((diff) => diff.file === item.path))
  if (!props.controls.session.reviewPanel.opened()) props.controls.session.reviewPanel.open()
  if (review) {
    layout.fileTree.setTab("changes")
    props.controls.session.tabs.setActive("review")
    queueFocus()
    return
  }
  layout.fileTree.setTab("all")
  const tab = files.tab(item.path)
  void props.controls.session.tabs.open(tab)
  props.controls.session.tabs.setActive(tab)
  void Promise.resolve(files.load(item.path)).finally(() => queueFocus())
}
