import { createMemo, For, Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import type { Jolli } from "@opencode-ai/schema/jolli"
import {
  PromptInputV2,
  type PromptInputV2PersistedState,
  type PromptInputV2Suggestion,
} from "@opencode-ai/session-ui/v2/prompt-input"
import { createPromptInputV2Controller } from "@opencode-ai/session-ui/v2/prompt-input/interaction"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import {
  groupChatAssistantId,
  groupChatModel,
  groupChatRecipient,
  groupChatSendRequest,
  groupChatTargetPrompt,
} from "@/jolli/group-chat-composer"
import { useAgentModelPreferences } from "@/jolli/agent-model-preferences"
import { parseModelKey } from "@/jolli/model-grant"
import { useLanguage } from "@/context/language"
import { assistantsForCourse } from "@/jolli/catalog"
import { groupChatRefusal, type GroupChatRefusal } from "@/jolli/group-chat"

export function GroupChatComposer(props: {
  chat: Jolli.GroupChat
  draft: ReturnType<typeof createStore<PromptInputV2PersistedState>>
  disabled: boolean
  sendDisabled?: boolean
  locked?: boolean
  onPasteFiles?: (files: File[]) => void
  onAttach?: () => void
  onMaterials: () => void
  onDictate?: () => void
  features: Jolli.GroupChatFeatures
  featuresLoading: boolean
  onReloadFeatures: () => void
  /** The agent this reader last asked here, already checked against who may be asked now. */
  target: number | null
  /** Remembers an agent picked from the mention menu, or clears the recipient. */
  onTarget: (assistantId: number | null) => void
  /** Who the running answer is for, named in the busy notice. */
  running?: { agent: string; asker: string }
  post: (body: Jolli.GroupChatPost) => Promise<Jolli.GroupChatAnswer>
  children?: JSX.Element
  attachmentIds?: readonly number[]
  pinnedMaterialIds?: readonly number[]
}) {
  const language = useLanguage()
  const preferences = useAgentModelPreferences()
  const [state, setState] = createStore<{ sending: boolean; busy: boolean; error?: GroupChatRefusal }>({
    sending: false,
    busy: false,
  })
  const agents = () => props.chat.group.mentionable ?? []
  const recipient = createMemo(() => {
    const id = groupChatRecipient(props.draft[0].prompt, props.target)
    return agents().some((agent) => agent.id === id) ? id : null
  })
  const assistantId = () => groupChatAssistantId(props.chat.courseId, recipient())
  const model = createMemo(() => {
    const preference = parseModelKey(preferences.get(assistantId()))
    return groupChatModel(
      props.features.composer,
      recipient(),
      preference?.providerID === "jolli" ? preference.modelID : undefined,
    )
  })
  /**
   * Only a catalogue that lists the agent with no usable model stops a question. Without a catalogue
   * the question goes without a model and the server answers with the agent's own.
   */
  const noModels = () =>
    recipient() !== null &&
    props.features.composer?.assistants.some((agent) => agent.id === recipient()) === true &&
    !model().options.length
  const askBlocked = () => noModels() || (model().options.length > 0 && !preferences.ready())
  const controlsDisabled = () => props.disabled || props.locked || state.sending
  const recipientName = () => agents().find((agent) => agent.id === recipient())?.name ?? ""
  const target = () => agents().find((agent) => agent.id === (recipient() ?? props.target))
  const suggestions = createMemo<PromptInputV2Suggestion[]>(() => [
    ...agents().map((agent) => ({
      id: `agent:${agent.id}`,
      kind: "agent" as const,
      label: agent.name,
      group: language.t("groupChat.agents"),
      mention: {
        type: "agent" as const,
        name: `agent:${agent.id}`,
        content: `@${agent.name}`,
        start: 0,
        end: agent.name.length + 1,
      },
    })),
    {
      id: "all",
      kind: "agent",
      icon: "group",
      label: language.t("groupChat.everyone"),
      group: language.t("groupChat.people"),
      mention: { type: "agent", name: "all", content: "@all", start: 0, end: 4 },
    },
    ...props.chat.group.participants
      .filter((person) => person.userId !== props.chat.viewerId)
      .map((person) => ({
        id: `person:${person.userId}`,
        kind: "agent" as const,
        icon: "person" as const,
        label: person.name,
        group: language.t("groupChat.people"),
        mention: {
          type: "agent" as const,
          name: `person:${person.userId}`,
          content: `@${person.name}`,
          start: 0,
          end: person.name.length + 1,
        },
      })),
  ])
  /** Keeps only the selected agent's mentions, preserving people, @all, attachments and words. */
  const updateAgentMentions = (assistantId?: number) => {
    const prompt = groupChatTargetPrompt(props.draft[0].prompt, assistantId)
    const text = prompt.map((part) => ("content" in part ? part.content : "")).join("")
    controller.onInput(text, prompt, text.length)
  }
  const draftBody = (groupOnly: boolean): Jolli.GroupChatPost => {
    const mentions = props.draft[0].prompt.flatMap((part) => (part.type === "agent" ? [part.name] : []))
    const assistant = groupOnly ? null : recipient()
    const modelId = model().selected
    return {
      message: controller.value().trim(),
      clientRequestId: crypto.randomUUID(),
      ...(assistant !== null ? { mentionedAssistantId: assistant, ...(modelId ? { modelId } : {}) } : {}),
      mentionedUserIds: mentions
        .filter((mention) => mention.startsWith("person:"))
        .map((mention) => Number(mention.slice(7))),
      mentionsAll: mentions.includes("all"),
      ...(props.attachmentIds?.length ? { attachmentIds: props.attachmentIds } : {}),
      ...(props.pinnedMaterialIds?.length ? { pinnedMaterialIds: props.pinnedMaterialIds } : {}),
    }
  }
  let pending: { signature: string; body: Jolli.GroupChatPost } | undefined
  const send = async (groupOnly = false) => {
    if (controlsDisabled() || props.sendDisabled || !controller.value().trim()) return
    if (!groupOnly && askBlocked()) return
    setState({ sending: true, busy: false, error: undefined })
    const text = JSON.stringify(props.draft[0].prompt)
    // A send whose fate is unknown is retried under the same request id, so the server keeps one copy.
    pending = groupChatSendRequest(pending, props.draft[0].prompt, draftBody(groupOnly), groupOnly)
    const body = pending.body
    const answer = await props.post(body).catch(() => undefined)
    setState("sending", false)
    if (answer?.status === "ok") {
      if (JSON.stringify(props.draft[0].prompt) === text)
        props.draft[1]("prompt", [{ type: "text", content: "", start: 0, end: 0 }])
      pending = undefined
      return
    }
    // A definite refusal frees the request id; a lost answer keeps it for the retry. A lost message to
    // the group keeps its button too, so the retry can go the same way.
    if (answer && answer.status !== "unreachable") pending = undefined
    if (groupOnly && (!answer || answer.status === "unreachable")) setState("busy", true)
    // The page tells of lost access itself, and a lost sign-in drops the chat with its draft.
    if (answer?.status === "revoked" || answer?.status === "signed-out") return
    if (answer?.code === "agent_busy") {
      setState("busy", true)
      return
    }
    if (answer?.code === "assistant_not_mentionable") updateAgentMentions()
    const carried = !!(body.attachmentIds?.length || body.pinnedMaterialIds?.length)
    setState("error", answer ? groupChatRefusal(answer, "send", carried) : { key: "groupChat.sendFailed" })
  }
  const controller = createPromptInputV2Controller({
    store: props.draft,
    allowShell: false,
    commands: () => {
      const target = recipient()
      const assistant = assistantsForCourse(props.chat.courseId).find(
        (agent) => Number(agent.id.split(":").at(-1)) === target,
      )
      return (assistant?.skills ?? []).map((skill) => ({
        id: skill.skillId,
        kind: "command" as const,
        label: `/${skill.skillId.replace(/^course:/, "")}`,
        title: skill.name,
        trigger: `/${skill.skillId.replace(/^course:/, "")}`,
      }))
    },
    context: suggestions,
    searchContextFiles: () => [],
    onSuggestionSelect(item) {
      const mention = item.mention
      if (controlsDisabled() || mention?.type !== "agent" || !mention.name.startsWith("agent:")) return undefined
      const assistantId = Number(mention.name.slice(6))
      return () => {
        updateAgentMentions(assistantId)
        props.onTarget(assistantId)
      }
    },
    view: {
      add: {
        onAttach: () => {
          if (!props.disabled && !props.locked) props.onAttach?.()
        },
      },
      onDrop: (event) => {
        const files = Array.from(event.dataTransfer?.files ?? [])
        if (!files.length) return
        event.preventDefault()
        event.stopPropagation()
        if (!controlsDisabled()) props.onPasteFiles?.(files)
      },
      onPaste: (event) => {
        const files = Array.from(event.clipboardData?.files ?? [])
        if (!files.length) return
        event.preventDefault()
        if (!controlsDisabled()) props.onPasteFiles?.(files)
      },
      placeholder: () =>
        recipient() === null
          ? language.t("groupChat.placeholder")
          : language.t("groupChat.askPlaceholder", { agent: recipientName() }),
      submit: { stopping: () => false, working: () => state.sending, onSubmit: () => void send(), onStop: () => {} },
    },
  })
  return (
    <div class="group-chat-composer" data-testid="group-chat-composer">
      <Show when={state.busy}>
        <div class="group-chat-busy" role="status">
          <span>
            {props.running
              ? language.t("groupChat.busyFor", { agent: props.running.agent, name: props.running.asker })
              : language.t("groupChat.busy")}
          </span>
          <ButtonV2 size="small" variant="outline" onClick={() => void send(true)}>
            {language.t("groupChat.sendInstead")}
          </ButtonV2>
        </div>
      </Show>
      <Show when={state.error}>
        {(error) => (
          <p class="group-chat-error" role="alert">
            {error().message ?? language.t(error().key)}
          </p>
        )}
      </Show>
      <PromptInputV2
        controller={controller}
        attachmentControl={props.children}
        addControl={
          props.locked ? null : (
            <MenuV2 gutter={8} placement="top-start" modal={false}>
              <MenuV2.Trigger
                as="button"
                type="button"
                class="group-chat-add-control"
                aria-label={language.t("groupChat.addMenu")}
                disabled={controlsDisabled()}
                data-testid="group-chat-add"
              >
                <Icon name="plus" />
              </MenuV2.Trigger>
              <MenuV2.Portal>
                <MenuV2.Content class="group-chat-composer-menu">
                  <MenuV2.Item onSelect={() => props.onAttach?.()}>{language.t("groupChat.attach")}</MenuV2.Item>
                  <MenuV2.Item onSelect={props.onMaterials}>{language.t("groupChat.materials")}</MenuV2.Item>
                  <Show when={props.onDictate}>
                    <MenuV2.Item onSelect={() => props.onDictate?.()}>{language.t("groupChat.dictate")}</MenuV2.Item>
                  </Show>
                  <Show when={agents().length}>
                    <MenuV2.Separator />
                    <MenuV2.Item onSelect={() => controller.openContext()}>
                      {language.t("groupChat.mention")}
                    </MenuV2.Item>
                  </Show>
                </MenuV2.Content>
              </MenuV2.Portal>
            </MenuV2>
          )
        }
        modelControl={
          props.locked ? null : (
            <Show when={target()}>
              {(agent) => (
                <div class="group-chat-agent-controls">
                  <div
                    class="group-chat-target-chip"
                    data-testid="group-chat-target-chip"
                    data-overridden={recipient() !== agent().id}
                    data-disabled={controlsDisabled()}
                    role="group"
                    aria-label={language.t("groupChat.ask", { agent: agent().name })}
                  >
                    <span class="group-chat-target-status" aria-hidden="true" />
                    <span class="group-chat-target-label" title={language.t("groupChat.ask", { agent: agent().name })}>
                      {language.t("groupChat.ask", { agent: agent().name })}
                    </span>
                    <button
                      type="button"
                      class="group-chat-target-clear"
                      disabled={controlsDisabled()}
                      aria-label={language.t("common.clear")}
                      title={language.t("common.clear")}
                      data-testid="group-chat-target-clear"
                      onClick={() => {
                        if (controlsDisabled()) return
                        updateAgentMentions()
                        props.onTarget(null)
                        controller.restoreFocus()
                      }}
                    >
                      <Icon name="xmark-small" />
                    </button>
                  </div>
                  <Show when={recipient() !== null}>
                    <MenuV2 gutter={8} placement="top-start" modal={false}>
                      <MenuV2.Trigger
                        as="button"
                        type="button"
                        class="group-chat-model-control"
                        disabled={controlsDisabled() || props.featuresLoading || !preferences.ready()}
                        aria-label={language.t("groupChat.chooseModel", {
                          agent: recipientName(),
                        })}
                        data-testid="group-chat-model"
                      >
                        <Icon name="assistant-sparkles" class="group-chat-model-icon" />
                        <span>
                          {model().options.find((item) => item.id === model().selected)?.name ??
                            language.t(
                              props.featuresLoading
                                ? "groupChat.loadingModels"
                                : noModels()
                                  ? "groupChat.modelsUnavailable"
                                  : "groupChat.defaultModel",
                            )}
                        </span>
                        <Icon name="chevron-down" class="group-chat-model-chevron" />
                      </MenuV2.Trigger>
                      <MenuV2.Portal>
                        <MenuV2.Content class="group-chat-composer-menu group-chat-model-menu">
                          <MenuV2.Group>
                            <MenuV2.GroupLabel>
                              {language.t("groupChat.chooseModel", {
                                agent: recipientName(),
                              })}
                            </MenuV2.GroupLabel>
                            <MenuV2.RadioGroup
                              value={model().selected ?? ""}
                              onChange={(value) => preferences.set(assistantId(), `jolli/${value}`)}
                            >
                              <For each={model().options}>
                                {(item) => (
                                  <MenuV2.RadioItem value={item.id} closeOnSelect>
                                    {item.name}
                                  </MenuV2.RadioItem>
                                )}
                              </For>
                            </MenuV2.RadioGroup>
                          </MenuV2.Group>
                          <Show when={!model().options.length}>
                            <MenuV2.Item onSelect={props.onReloadFeatures}>
                              {language.t("groupChat.retryModels")}
                            </MenuV2.Item>
                          </Show>
                        </MenuV2.Content>
                      </MenuV2.Portal>
                    </MenuV2>
                  </Show>
                </div>
              )}
            </Show>
          )
        }
        disabled={props.disabled}
        readOnly={props.locked}
        submitDisabled={props.sendDisabled || controlsDisabled() || (recipient() !== null && askBlocked())}
        variantControlVisible={false}
      />
      <Show when={recipient() !== null}>
        <p class="group-chat-boundary">
          {language.t(noModels() ? "groupChat.noModels" : "groupChat.agentBoundary", { agent: recipientName() })}
        </p>
      </Show>
    </div>
  )
}
