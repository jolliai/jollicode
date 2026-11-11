import type { ParentProps } from "solid-js"
import { Show } from "solid-js"
import { Dialog, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { useLanguage } from "@/context/language"
import "./conversation-dialog.css"

export function ConversationDialog(props: ParentProps<{ title: string; onBack?: () => void; busy?: boolean }>) {
  const language = useLanguage()
  return (
    <Dialog fit class="conversation-dialog" containerClass="conversation-dialog-container">
      <DialogHeader>
        <Show when={props.onBack}>
          <button
            type="button"
            class="conversation-dialog-back"
            aria-label={language.t("ui.common.back")}
            disabled={props.busy}
            onClick={() => props.onBack?.()}
          >
            <Icon name="chevron-down" class="rotate-90 rtl:-rotate-90" />
          </button>
        </Show>
        <DialogTitle>{props.title}</DialogTitle>
      </DialogHeader>
      {props.children}
    </Dialog>
  )
}
