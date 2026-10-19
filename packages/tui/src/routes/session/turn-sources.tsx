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
 * message answering the same user message. It is mounted on a finished message, and draws only on
 * the newest message of its turn, so a turn shows the row once, as the desktop does.
 *
 * ⚠ ONLY THE STEPS UNDER THIS MESSAGE'S OWN USER MESSAGE. A turn auto-compaction cut in two whose
 * answer sits before the compaction, with nothing written after it, keeps its sources on a step this
 * row never gathers; the desktop timeline draws them there, and the TUI shows none for that turn.
 * Gathering across the compaction would mean walking the compaction messages back here as the sidecar
 * does (`CourseSources`), for a turn that rarely ends that way.
 *
 * ⚠ EACH ROW FILTERS THE SESSION'S MESSAGES, AND THAT IS KEPT. It runs only in a course session, and
 * again only when messages are added or removed, not as a reply streams in. A grouping shared by every
 * row would have to be built above the message list and threaded down to it, which costs more than
 * the filter does.
 *
 * ⚠ THE ASSIGNMENTS LINK IS NO SOURCE, so it is drawn whether or not the course shows citations: it
 * is where the answer sends the student, when the turn asked about assignments its agent does not
 * read (`JolliSources.turnAssignmentsUrl`).
 */
export function TurnSources(props: { message: AssistantMessage }) {
  const { theme } = useTheme()
  const sync = useSync()
  const jolli = useJolli()

  const turnParts = createMemo(() => {
    if (!jolli.assistant()) return undefined
    const turn = (sync.data.message[props.message.sessionID] ?? []).filter(
      (message) => message.role === "assistant" && message.parentID === props.message.parentID,
    )
    // A step can finish with "stop" and still call tools, and then a turn has two final messages;
    // only its newest one draws the row.
    if (turn.at(-1)?.id !== props.message.id) return undefined
    return turn.flatMap((message) => sync.data.part[message.id] ?? [])
  })
  const sources = createMemo(() => {
    const parts = turnParts()
    return parts && jolli.assistant()?.guardrails.showCitations ? JolliSources.turnSources(parts) : undefined
  })
  const assignmentsUrl = createMemo(() => {
    const parts = turnParts()
    return parts ? JolliSources.turnAssignmentsUrl(parts) : undefined
  })

  return (
    <Show when={sources() || assignmentsUrl()}>
      <box paddingLeft={3} marginTop={1} flexDirection="column">
        <Show when={sources()}>
          {(turn) => (
            <>
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
              <For each={turn().materials}>
                {(material) => (
                  <Show when={material.url}>
                    {(url) => (
                      <box paddingLeft={2}>
                        <Link href={url()} fg={theme.primary} />
                      </box>
                    )}
                  </Show>
                )}
              </For>
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
            </>
          )}
        </Show>
        <Show when={assignmentsUrl()}>
          {(url) => (
            <>
              <text fg={theme.textMuted}>View assignments:</text>
              <box paddingLeft={2}>
                <Link href={url()} fg={theme.primary} />
              </box>
            </>
          )}
        </Show>
      </box>
    </Show>
  )
}
