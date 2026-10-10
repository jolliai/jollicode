import { For, Show, createMemo } from "solid-js"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import { JolliSources } from "@opencode-ai/core/jolli/sources"
import { useJolli } from "../../context/jolli"
import { useSync } from "../../context/sync"
import { useTheme } from "../../context/theme"
import { Link } from "../../ui/link"

/**
 * WHAT ONE COURSE TURN DREW ON, UNDER ITS ANSWER — THE TUI'S COPY OF THE DESKTOP'S SOURCES ROW.
 *
 * ⚠ THE DECISION IS SHARED, THE DRAWING IS NOT. Which sources a turn had comes from
 * `JolliSources.turnSources`, the same reading the desktop timeline makes, so the two surfaces agree
 * about every turn. English only: the TUI has no dictionary.
 *
 * ⚠ READS THE WHOLE TURN, NOT THIS MESSAGE. A turn is one assistant message per step, and the course
 * tools usually ran in an earlier step than the one that answered, so it gathers every assistant
 * message answering the same user message. It is mounted on the turn's final message only.
 */
export function TurnSources(props: { message: AssistantMessage }) {
  const { theme } = useTheme()
  const sync = useSync()
  const jolli = useJolli()

  const policy = createMemo(() => {
    const guardrails = jolli.assistant()?.guardrails
    if (!guardrails) return undefined
    return { showCitations: guardrails.showCitations }
  })
  const sources = createMemo(() => {
    const current = policy()
    if (!current) return undefined
    const parts = (sync.data.message[props.message.sessionID] ?? [])
      .filter((message) => message.role === "assistant" && message.parentID === props.message.parentID)
      .flatMap((message) => sync.data.part[message.id] ?? [])
    return JolliSources.turnSources(parts, current)
  })

  return (
    <Show when={sources()}>
      {(turn) => (
        <box paddingLeft={3} marginTop={1} flexDirection="column">
          <Show when={turn().materials.length > 0}>
            <text fg={theme.textMuted}>
              Course materials:{" "}
              <span style={{ fg: theme.text }}>
                {turn()
                  .materials.map((item) => item.title)
                  .join(" · ")}
              </span>
            </text>
          </Show>
          <Show when={turn().web.length > 0}>
            <text fg={theme.textMuted}>Web pages:</text>
            <For each={turn().web}>
              {(page) => (
                <box paddingLeft={2}>
                  <Link href={page.url} fg={theme.primary} />
                </box>
              )}
            </For>
          </Show>
        </box>
      )}
    </Show>
  )
}
