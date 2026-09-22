import { createStore } from "solid-js/store"
import { onCleanup, Show, type Accessor } from "solid-js"
import { InlineInput } from "@opencode-ai/ui/inline-input"

export function createInlineEditorController() {
  // This controller intentionally supports one active inline editor at a time.
  const [editor, setEditor] = createStore({
    active: "" as string,
    value: "",
  })

  const editorOpen = (id: string) => editor.active === id
  const editorValue = () => editor.value
  const openEditor = (id: string, value: string) => {
    if (!id) return
    setEditor({ active: id, value })
  }
  const closeEditor = () => setEditor({ active: "", value: "" })

  const saveEditor = (callback: (next: string) => void) => {
    const next = editor.value.trim()
    if (!next) {
      closeEditor()
      return
    }
    closeEditor()
    callback(next)
  }

  const editorKeyDown = (event: KeyboardEvent, callback: (next: string) => void) => {
    if (event.key === "Enter") {
      event.preventDefault()
      saveEditor(callback)
      return
    }
    if (event.key !== "Escape") return
    event.preventDefault()
    closeEditor()
  }

  const InlineEditor = (props: {
    id: string
    value: Accessor<string>
    onSave: (next: string) => void
    class?: string
    displayClass?: string
    editing?: boolean
    stopPropagation?: boolean
    openOnDblClick?: boolean
  }) => {
    let frame: number | undefined

    onCleanup(() => {
      if (frame === undefined) return
      cancelAnimationFrame(frame)
    })

    const isEditing = () => props.editing ?? editorOpen(props.id)
    const stopEvents = () => props.stopPropagation ?? false
    const allowDblClick = () => props.openOnDblClick ?? true
    const stopPropagation = (event: Event) => {
      if (!stopEvents()) return
      event.stopPropagation()
    }
    /**
     * WHAT THE *DISPLAYED* TITLE SWALLOWS, WHICH IS NOT THE SAME QUESTION AS WHAT THE FIELD SWALLOWS.
     *
     * ⚠ THE READ-ONLY LABEL ONLY HAS THE RIGHT TO EAT A CLICK IF IT DOES SOMETHING WITH IT. Opening
     * on double-click is that something: dblclick arrives after two ordinary clicks, so without the
     * stops the row behind would fire twice on the way to becoming a text field. With
     * `openOnDblClick={false}` the label has no behaviour at all — it is text — and swallowing
     * clicks there made the sidebar's session rows reachable only by their leading avatar, with the
     * title, the widest part of the row, inert.
     *
     * ⚠ THE EDITING BRANCH STILL HONOURS `stopPropagation` UNCONDITIONALLY. An open field is the
     * one case where a click genuinely is not the row's: clicking into the text to reposition the
     * caret must not navigate away from what you are renaming.
     */
    const stopDisplayPropagation = (event: Event) => {
      if (!allowDblClick()) return
      stopPropagation(event)
    }
    const handleDblClick = (event: MouseEvent) => {
      if (!allowDblClick()) return
      stopPropagation(event)
      openEditor(props.id, props.value())
    }

    return (
      <Show
        when={isEditing()}
        fallback={
          <span
            class={props.displayClass ?? props.class}
            onDblClick={handleDblClick}
            onPointerDown={stopDisplayPropagation}
            onMouseDown={stopDisplayPropagation}
            onClick={stopDisplayPropagation}
            onTouchStart={stopDisplayPropagation}
          >
            {props.value()}
          </span>
        }
      >
        <InlineInput
          ref={(el) => {
            if (frame !== undefined) cancelAnimationFrame(frame)
            frame = requestAnimationFrame(() => {
              frame = undefined
              if (!el.isConnected) return
              el.focus()
            })
          }}
          value={editorValue()}
          class={props.class}
          onInput={(event) => setEditor("value", event.currentTarget.value)}
          onKeyDown={(event) => {
            event.stopPropagation()
            editorKeyDown(event, props.onSave)
          }}
          onBlur={closeEditor}
          onPointerDown={stopPropagation}
          onClick={stopPropagation}
          onDblClick={stopPropagation}
          onMouseDown={stopPropagation}
          onMouseUp={stopPropagation}
          onTouchStart={stopPropagation}
        />
      </Show>
    )
  }

  return {
    editor,
    editorOpen,
    editorValue,
    openEditor,
    closeEditor,
    saveEditor,
    editorKeyDown,
    setEditor,
    InlineEditor,
  }
}
