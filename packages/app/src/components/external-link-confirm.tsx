import { onCleanup } from "solid-js"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { safeReferenceUrl } from "@/jolli/reference-preview"
import { GroupChatConfirmation } from "./group-chat-dialogs"

/**
 * Open an address from shared or untrusted content only after the person has seen it in full and
 * confirmed. Resolves whether the browser was opened. Pair with `guardExternalLinks` so that links
 * the content draws itself come here too, instead of leaving through the window's default action.
 */
export function useExternalLinkConfirm() {
  const confirm = useConfirmation()
  const language = useLanguage()
  const platform = usePlatform()
  return async (value: string) => {
    const url = safeReferenceUrl(value)
    if (!url) return false
    const confirmed = await confirm({
      title: language.t("groupChat.openLink"),
      detail: `${language.t("groupChat.openLinkHint")}\n\n${url}`,
      confirm: language.t("groupChat.open"),
    })
    if (confirmed) platform.openExternal(url)
    return confirmed
  }
}

/**
 * A confirmation that settles exactly once: true on confirm, false when it is dismissed or another
 * dialog replaces it. `dialog.show` settles when the dialog appears, not when it closes, and the
 * dialog's own close callback runs before its confirm action, so neither can tell the two apart.
 */
export function useConfirmation() {
  const dialog = useDialog()
  return (input: { title: string; detail: string; confirm: string }) =>
    new Promise<boolean>((resolve) => {
      void dialog.show(() => {
        // The confirm button closes the dialog, which may unmount it at once, and only then runs its
        // action in the same click. Settling the dismissal a microtask later lets that action win.
        onCleanup(() => queueMicrotask(() => resolve(false)))
        return <GroupChatConfirmation {...input} onConfirm={() => resolve(true)} />
      })
    })
}
