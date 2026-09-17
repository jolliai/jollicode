/**
 * THE COACHING NUDGE BESIDE ONE FINISHED TURN, AND THE ADAPTER THAT FEEDS IT.
 *
 * ⚠ TWO HALVES WITH ONE RULE BETWEEN THEM. `coachTurnInputFor` turns SDK messages into the counts
 * and flags `jolli/coaching.ts` reads; `CoachNudgeRow` renders what that produced. Everything about
 * WHICH nudge fires lives in the domain layer — this file must never grow a branch of its own,
 * because a rubric switch the professor set has to be the only thing that decides what a student is
 * coached about.
 *
 * ⚠ THE DERIVED SENTENCE RENDERS FIRST AND IMMEDIATELY. A sharpened one may replace it when a writer
 * is registered, so there is no spinner and no empty frame: the nudge is complete from the first
 * paint, and the model only ever improves wording that already stood on its own.
 */
import { For, createEffect, createSignal, onCleanup, Show } from "solid-js"
import { HoverCard } from "@opencode-ai/ui/hover-card"
import { Icon } from "@opencode-ai/ui/icon"
import type { AssistantMessage, Part, UserMessage } from "@opencode-ai/sdk/v2"
import type { CoachTrigger, CoachTurnInput } from "@/jolli/coaching"
import { CoachWriter, coachProse, coachProseRequest } from "@/jolli/coaching-prose"
import type { Assistant, SessionSharing } from "@/jolli/types"

const textOf = (parts: Part[]) =>
  parts
    .flatMap((part) => (part.type === "text" && part.text ? [part.text] : []))
    .join("\n")
    .trim()

/**
 * WHAT ONE TURN LOOKS LIKE TO THE GATE.
 *
 * ⚠ IT READS EVERY ASSISTANT MESSAGE OF THE TURN, NOT JUST THE LAST. A turn that ran tools, was
 * interrupted and resumed is several assistant messages against one user message, and a nudge about
 * "nothing ran afterwards" that only looked at the final message would be wrong about exactly the
 * turns most worth coaching.
 */
export function coachTurnInputFor(input: {
  assistant: Assistant | undefined
  user: UserMessage
  assistants: AssistantMessage[]
  parts: (messageID: string) => Part[]
}): CoachTurnInput {
  const userParts = input.parts(input.user.id)
  const assistantParts = input.assistants.flatMap((message) => input.parts(message.id))
  /* The model that ran the turn is the one that started it; a resumed turn cannot switch models. */
  const first = input.assistants[0]
  return {
    assistant: input.assistant,
    promptText: textOf(userParts),
    promptFileCount: userParts.filter((part) => part.type === "file").length,
    answerWords: textOf(assistantParts).split(/\s+/).filter(Boolean).length,
    tools: assistantParts.flatMap((part) =>
      part.type === "tool" ? [{ tool: part.tool, status: part.state.status }] : [],
    ),
    modelId: first ? `${first.providerID}/${first.modelID}` : undefined,
  }
}

/**
 * THE TWO SIDES OF THE EXCHANGE AS TEXT, FOR THE PROSE REQUEST ONLY.
 *
 * ⚠ SEPARATE FROM `coachTurnInputFor` ON PURPOSE, AND THE SPLIT IS THE PRIVACY RULE IN THE TYPE
 * SYSTEM. `CoachTurnInput` carries counts and flags because the gate must never be able to emit the
 * body; this carries the body because `coachProseRequest` may hand it to a writer — but only after
 * it has checked `sharing.staff`. Two functions means neither call site can quietly acquire the
 * other's privileges.
 */
export function exchangeTextFor(input: {
  user: UserMessage
  assistants: AssistantMessage[]
  parts: (messageID: string) => Part[]
}) {
  return {
    prompt: textOf(input.parts(input.user.id)),
    reply: textOf(input.assistants.flatMap((message) => input.parts(message.id))),
  }
}

/**
 * THE COACH BADGE, AND ITS FLYOUT. Two states: unread says so in words, read is an icon and a digit.
 *
 * ⚠ IT IS AN INDICATOR, SO ITS PRESENCE IS THE WHOLE SIGNAL. `coachTurn` returns an empty array
 * rather than filler and the caller renders no row at all in that case. A mark on every answer marks
 * nothing, and the reader stops seeing it by the third one — the web mock found it doing exactly
 * that on 80 of 80 replies.
 *
 * ⚠ UNREAD IS TINTED AND SPELLED OUT; READ IS THE ICON AND THE DIGIT. An 11px icon is unmissable
 * once you know what it means and invisible until then, and every reader meets it for the first time
 * exactly once. The loud state costs the row a few characters on the turns that have something to
 * say, and nothing anywhere else.
 *
 * ⚠ THE TINT IS THE ACCENT PAIR, WHICH IS THE PRODUCT'S "THIS ONE IS NOTABLE" AND NOT AN ALARM. No
 * new token — `text-v2-text-text-accent` already exists and carries the fork's brand ramp. A danger
 * token here would say the assistant went wrong, which is the mistake the design guide spends a rule
 * on for refusals, aimed at the student instead of at the model.
 *
 * ⚠ A HoverCard, NOT A TOOLTIP, AND THE DIFFERENCE IS NOT STYLE. This content is several sentences
 * and has to be readable at a pace: a tooltip is for a phrase, dismisses on any movement, and is not
 * reachable by keyboard as a region. A HoverCard opens on hover AND on focus, stays while the
 * pointer is inside it, and is a focusable container. It is deliberately not a modal either — a
 * modal traps focus and demands dismissal, which is far too much ceremony for a remark the reader is
 * allowed to ignore.
 *
 * ⚠ READ IS NOT PERSISTED. A signal, so every reload brings the highlight back and there is no reset
 * control to build or find. Right for a mock: the first person to hover a badge while exploring
 * would otherwise never see the state the feature exists to show.
 */
export function CoachBadge(props: {
  triggers: CoachTrigger[]
  instructions: string
  sharing: SessionSharing
  prompt: string
  reply: string
}) {
  /**
   * ⚠ IT GOES QUIET WHEN THE CARD CLOSES, NOT WHEN IT OPENS, and the web mock records this as a
   * reproduced interaction bug rather than a preference. The two states are different WIDTHS — "2
   * coaching notes" against a digit — so marking it read on open shrinks the trigger under the
   * pointer that is still on it. The cursor ends up outside the element it is hovering, the card
   * closes itself, and the thing the reader just opened flickers shut.
   */
  const [read, setRead] = createSignal(false)
  /**
   * ⚠ DEFENSIVE, AND THE REASON IS A FATAL RENDERER ERROR RATHER THAN TIDINESS. Reading
   * `props.triggers.length` straight off the prop threw `undefined is not an object` inside a render
   * effect during a hot reload, which takes the whole renderer down rather than this one badge. An
   * empty list is already this feature's most ordinary state and its rendering is no badge at all,
   * so falling back to it costs nothing and removes a class of crash.
   */
  const triggers = () => props.triggers ?? []
  const label = () => (triggers().length === 1 ? "Coaching note" : `${triggers().length} coaching notes`)

  return (
    <Show when={triggers().length > 0}>
      {/* ⚠ `data-coach-persist` IS WHAT KEEPS THIS ONE VISIBLE. Its siblings in the action row fade
          out when the reply is not hovered; `message-part.css` exempts this attribute, because a
          coaching badge is an indicator nobody knows to look for while copy is an affordance the
          reader goes looking for. It stops persisting once it has been read, at which point it is
          just another control on the row. */}
      <div
        data-coach-persist={read() ? undefined : ""}
        /* The hover-card trigger stretches to its container (hover-card.css), so the container is
           what keeps the badge down to its own width. */
        class="w-fit"
      >
        <HoverCard
          openDelay={120}
          closeDelay={80}
          placement="bottom-start"
          onOpenChange={(open) => !open && setRead(true)}
          trigger={
            <button
              type="button"
              data-coach-nudge={triggers()
                .map((t) => t.id)
                .join(",")}
              data-coach-read={read() ? "true" : undefined}
              /* ⚠ THE ACCESSIBLE NAME IS THE SAME IN BOTH STATES AND CARRIES THE COUNT, because
                   the unread tint is the one part of this control a screen reader cannot have. It
                   does not announce "unread": that is a visual prompt to look, and the reader it is
                   prompting is already here. */
              aria-label={`${label()}: ${triggers().length}`}
              classList={{
                "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] leading-4 transition-colors": true,
                "text-v2-text-text-faint hover:text-v2-text-text-base": read(),
                "font-[560] text-v2-text-text-accent": !read(),
              }}
            >
              {/* ⚠ THE COLOUR GOES ON THE SVG, NOT ON THE BUTTON, AND THAT IS NOT A STYLE CHOICE.
                    `icon.css` sets `color: var(--icon-base)` on the icon's own wrapper div, so the
                    accent inherited from the button stops there and the glyph renders grey while the
                    label beside it is tinted. `Icon`'s `classList` lands on the `<svg>` itself, which
                    is inside that wrapper and therefore wins. */}
              <Icon
                name="graduation-cap"
                size="small"
                classList={{
                  "size-3.5 shrink-0": true,
                  "text-v2-text-text-faint": read(),
                  "text-v2-text-text-accent": !read(),
                }}
                aria-hidden="true"
              />
              <Show when={read()} fallback={<span>{label()}</span>}>
                <span class="tabular-nums">{triggers().length}</span>
              </Show>
            </button>
          }
        >
          {/* ⚠ A FLAT LIST OF PARAGRAPHS AND NO HEADINGS. The web mock filed these under three
                labelled sections and removed them: the notes come out of the gate in a stable order
                because its groups run in a stable order, and a set that is usually one note long
                never had a filing problem. */}
          <div class="flex max-w-[320px] flex-col gap-2 p-2.5">
            <For each={triggers()}>
              {(trigger) => (
                <CoachNoteText
                  trigger={trigger}
                  instructions={props.instructions}
                  sharing={props.sharing}
                  prompt={props.prompt}
                  reply={props.reply}
                />
              )}
            </For>
          </div>
        </HoverCard>
      </div>
    </Show>
  )
}

/**
 * ONE NOTE'S PROSE.
 *
 * ⚠ THE DERIVED SENTENCE RENDERS FIRST AND IMMEDIATELY. A sharpened one may replace it when a writer
 * is registered, so there is no spinner and no empty frame: the note is complete from first paint,
 * and a model only ever improves wording that already stood on its own.
 */
function CoachNoteText(props: {
  trigger: CoachTrigger
  instructions: string
  sharing: SessionSharing
  prompt: string
  reply: string
}) {
  const request = () =>
    coachProseRequest({
      trigger: props.trigger,
      instructions: props.instructions,
      sharing: props.sharing,
      prompt: props.prompt,
      reply: props.reply,
    })
  /**
   * ⚠ A SIGNAL AND AN EFFECT, NOT `createResource`, AND THE DIFFERENCE IS NOT STYLE — THE RESOURCE
   * VERSION TORE DOWN THE WHOLE SESSION. `pages/session.tsx` wraps this route in `<Suspense>`, and a
   * reading resource suspends its NEAREST boundary, not its own subtree. So the first hover on a
   * badge put the entire session on its fallback and rebuilt it: the transcript lost its scroll
   * position (jumping ~228px to the top) and the composer's model chip flashed as it remounted. Two
   * symptoms, one cause, and neither of them anywhere near this file.
   *
   * ⚠ SO NOTHING HERE MAY EVER SUSPEND. The derived sentence is synchronous and always correct, and
   * a writer is an optional improvement on it — that is a fit for a signal that starts right and
   * gets better, and a bad fit for a primitive whose whole purpose is to tell a boundary to wait.
   */
  const [text, setText] = createSignal(props.trigger.text)
  createEffect(() => {
    const value = request()
    setText(value.trigger.text)
    const writer = CoachWriter.get()
    if (!writer) return
    let cancelled = false
    onCleanup(() => {
      cancelled = true
    })
    void coachProse(value, writer).then((written) => {
      if (!cancelled) setText(written)
    })
  })
  return <p class="text-[12px] leading-relaxed text-v2-text-text-muted">{text()}</p>
}
