import { createEffect, createMemo, on } from "solid-js"
import { useJolli } from "../context/jolli"
import { useTheme } from "../context/theme"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"

/**
 * WHOSE ASSISTANT ANSWERS IN THIS SESSION.
 *
 * ⚠ AN ASSISTANT IS NOT AN AGENT, AND THE TWO DIALOGS SITTING SIDE BY SIDE IS THE RISK. `/agents`
 * picks build or plan — opencode's own idea of how to work. This picks the professor-authored
 * assistant whose instructions, guardrails and model grant the session runs under. A student can
 * hold both at once; only this one is fixed for the life of the session.
 *
 * ⚠ IT REFUSES BEFORE IT OPENS WHEN NO COURSE IS CHOSEN, because an assistant belongs to exactly
 * one course — there is no list to show until that is settled.
 *
 * ⚠ A LOCKED SESSION LISTS ONLY ITS OWN ASSISTANT, read off the binding like `DialogCourse` does.
 */
export function DialogAssistant() {
  const jolli = useJolli()
  const dialog = useDialog()
  const { theme } = useTheme()

  /** Closes once a session takes over the draft it was opened for — see `DialogCourse`. */
  const openedUnlocked = !jolli.locked()
  createEffect(
    on(jolli.locked, (locked) => {
      if (openedUnlocked && locked) dialog.clear()
    }),
  )

  const options = createMemo(() => {
    if (jolli.locked()) {
      const assistant = jolli.assistant()
      return assistant ? [{ value: assistant.id, title: assistant.name, description: assistant.blurb }] : []
    }
    return jolli.assistantsFor(jolli.course()?.id).map((assistant) => ({
      value: assistant.id,
      title: assistant.name,
      description: assistant.blurb,
    }))
  })

  return (
    <DialogSelect
      title={jolli.locked() ? "Assistant (fixed for this session)" : "Select assistant"}
      locked={jolli.locked()}
      current={jolli.assistant()?.id}
      options={options()}
      emptyView={
        <box paddingLeft={4} paddingRight={4}>
          <text fg={theme.textMuted}>
            {jolli.locked()
              ? "This session has no assistant."
              : jolli.course()
                ? `${jolli.course()?.code} has no assistants yet — your instructor sets these up.`
                : "Choose a course first."}
          </text>
        </box>
      }
      onSelect={(option) => {
        jolli.draft.setAssistant(option.value)
        dialog.clear()
      }}
    />
  )
}
