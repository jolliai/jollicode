import { createResource, Show } from "solid-js"
import { Schema } from "effect"
import type { Jolli } from "@opencode-ai/schema/jolli"
import type { ServerSDK } from "@/context/server-sdk"
import { useLanguage } from "@/context/language"
import { readReference, ReferenceArtifact, type ReferencePreview } from "@/jolli/reference-preview"

export function GroupChatArtifactCard(props: {
  sdk: ServerSDK
  chatID: Jolli.GroupChatID
  artifactId: string
  onOpen: (item: ReferencePreview, trigger: HTMLElement) => void
}) {
  const language = useLanguage()
  const [artifact] = createResource(
    () => props.artifactId,
    async (artifactId) =>
      Schema.decodeUnknownSync(ReferenceArtifact)(
        await readReference(props.sdk, { kind: "group", chatID: props.chatID }, { kind: "artifact", artifactId }),
      ),
  )
  return (
    <Show
      when={!artifact.loading && !artifact.error}
      fallback={
        <button type="button" class="group-chat-artifact-card" disabled>
          <span class="reference-kind">{language.t("groupChat.preview.artifact")}</span>
          <strong>{language.t(artifact.error ? "groupChat.preview.unavailable" : "groupChat.preview.loading")}</strong>
        </button>
      }
    >
      <button
        type="button"
        class="group-chat-artifact-card"
        disabled={!artifact()}
        onClick={(event) => {
          if (artifact.loading || artifact.error) return
          const value = artifact()
          if (!value) return
          props.onOpen(
            {
              key: `artifact:${props.artifactId}`,
              title: value.title,
              reference: { kind: "artifact", artifactId: props.artifactId },
            },
            event.currentTarget,
          )
        }}
      >
        <span class="reference-kind">{language.t("groupChat.preview.artifact")}</span>
        <strong>
          {artifact()?.title ??
            language.t(artifact.error ? "groupChat.preview.unavailable" : "groupChat.preview.loading")}
        </strong>
        <Show when={artifact()}>
          <span>{language.t("groupChat.preview.open")}</span>
        </Show>
      </button>
    </Show>
  )
}
