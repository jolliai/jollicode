import { groupMaterialReadable } from "@opencode-ai/core/jolli/group-chat-rules"
import { createResource, For, Show } from "solid-js"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useServerSDK } from "@/context/server-sdk"
import { ServerConnection } from "@/context/server"
import { useLanguage } from "@/context/language"
import { Schema } from "effect"
import { MaterialList, type ChatMaterial } from "@/jolli/group-chat-media"
import { decodeChatAnswer, useCloseOnGroupChatReset, useGroupChatAccount } from "@/jolli/group-chat"
export function GroupChatMaterialsDialog(props: {
  courseId: string
  selected: readonly number[]
  onPin: (material: ChatMaterial) => void
}) {
  const sdk = useServerSDK()
  const language = useLanguage()
  const dialog = useDialog()
  const account = useGroupChatAccount()
  useCloseOnGroupChatReset()
  const [materials] = createResource(async () => {
    const answer = decodeChatAnswer((await sdk().client.jolli.groupChatMaterials({ courseId: props.courseId })).data)
    // The window drops the server's chats, and this dialog closes with them.
    if (answer.status === "signed-out") account.signOut(ServerConnection.key(sdk().server))
    if (answer.status !== "ok") throw new Error("Course materials unavailable")
    const list = Schema.decodeUnknownSync(MaterialList)(answer.resource)
    return Array.isArray(list) ? list : "readings" in list ? list.readings : "materials" in list ? list.materials : []
  })
  // A failed read stays in this dialog; reading the resource itself would throw it to the app.
  const list = () => (materials.error ? [] : (materials() ?? []))
  return (
    <Dialog fit>
      <DialogHeader>
        <DialogTitle>{language.t("groupChat.materials")}</DialogTitle>
      </DialogHeader>
      <DialogBody class="group-chat-dialog">
        <For each={list()}>
          {(material) => (
            <div class="group-chat-person-row">
              <span class="min-w-0 flex-1 truncate">{material.title}</span>
              <Show when={!groupMaterialReadable(material)}>
                <span class="group-chat-muted">{language.t("groupChat.uploading")}</span>
              </Show>
              <ButtonV2
                size="small"
                variant="outline"
                disabled={
                  !groupMaterialReadable(material) || props.selected.length >= 4 || props.selected.includes(material.id)
                }
                onClick={() => props.onPin(material)}
              >
                {language.t("groupChat.add")}
              </ButtonV2>
            </div>
          )}
        </For>
        <Show when={materials.error}>
          <p class="group-chat-error" role="alert">
            {language.t("groupChat.actionFailed")}
          </p>
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
