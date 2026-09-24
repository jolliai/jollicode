/**
 * WHO CAN READ A SESSION ON JOLLI, AND THE CONTROL THAT CHANGES IT.
 *
 * Ported from jolliedu's `ChatSharePanel` and `ChatSharePicker`, and it replaces upstream's "Publish
 * on web" popover in the same slot. Upstream published a transcript to a public link on a third
 * party's servers; this names people in the session's course on the student's own Jolli account, so
 * a reader is always somebody the student can name.
 *
 * ⚠ THE SIDECAR HOLDS THE CREDENTIAL, NOT THIS COMPONENT. Every read and write goes through
 * `/jolli/session/:sessionID/share`, which answers with one composed shape. After a write the
 * readers are replaced wholesale from that answer (`applyWrite`) — jolliedu's rule, so the panel
 * never holds a second opinion about who can read.
 *
 * ⚠ IT SHARES ITS CACHE ENTRY WITH THE COACHING GATE (`use-session-share.ts`), so a write here
 * reaches the gate at once. It is mounted from the header — the participant stack and "Share…" —
 * and is the same panel from either.
 *
 * ⚠ LAID OUT AS THE WEB'S PANEL IS, BAND FOR BAND. **In this session** is who the session is WITH —
 * the student and the assistant that answered — and **Who can read it** is who has been LET IN.
 * Collapsing them would make being handed a session look like being part of it. The web calls it a
 * chat; this product calls it a session, which is the one deliberate difference in the wording.
 *
 * ⚠ THE PICKER IS A CARD INSIDE THE PANEL, NOT A NESTED POPOVER — jolliedu's reason: a second
 * popover mounts in its own portal, takes focus there, and the panel reads that as focus leaving
 * and dismisses itself. Same layer, so it carries its own way out: Escape and a close control.
 */

import type { Jolli } from "@opencode-ai/schema/jolli"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { useMutation, useQueryClient } from "@tanstack/solid-query"
import { createMemo, For, type JSX, Match, onCleanup, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { assistantIconName } from "@/jolli/assistant-icon"
import { viewer } from "@/jolli/catalog"
import { useCourseSession } from "@/jolli/session-binding"
import {
  applyWrite,
  initials,
  matchCandidates,
  pickerState,
  RENDER_CAP,
  shareCandidates,
  writeRefusal,
} from "@/jolli/session-share"
import type { Assistant } from "@/jolli/types"
import { courseLabel, shareQueryKey, useSessionShare } from "@/jolli/use-session-share"

const EVERYONE = "everyone"

export function SessionSharePanel(props: { sessionID: string }) {
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const binding = useCourseSession()
  const queryClient = useQueryClient()
  const [state, setState] = createStore({
    refusal: undefined as Jolli.ShareRefusal | undefined,
    picking: false,
    search: "",
  })

  const query = useSessionShare(() => props.sessionID, { fresh: true })

  /**
   * ⚠ EVERY WRITE'S ANSWER IS APPLIED AS IT LANDS, including the ones inside a bulk run, so a run
   * refused halfway still shows the grants that did land beside the refusal that stopped it.
   */
  const apply = (result: Jolli.SessionShare) => {
    queryClient.setQueryData<Jolli.SessionShare>(shareQueryKey(serverSDK().url, props.sessionID), (current) =>
      current ? applyWrite(current, result) : current,
    )
    return result
  }
  const add = (subject: Jolli.ShareSubject) =>
    serverSDK()
      .client.jolli.shareAdd({ sessionID: props.sessionID, subject }, { throwOnError: true })
      .then((response) => apply(response.data as Jolli.SessionShare))

  const write = useMutation(() => ({
    mutationFn: (run: () => Promise<Jolli.SessionShare | undefined>) => run(),
    onMutate: () => setState("refusal", undefined),
    onSuccess: (result) => setState("refusal", result ? writeRefusal(result) : undefined),
    onError: () => setState("refusal", "unknown"),
  }))

  const share = (subject: Jolli.ShareSubject) => write.mutate(() => add(subject))

  /**
   * NAMES SEVERAL PEOPLE IN ONE GESTURE — the staff group's bulk action.
   *
   * ⚠ SEQUENTIAL, AND IT STOPS AT THE FIRST WRITE THAT DOES NOT LAND. Each name is its own grant, so
   * carrying on past a refusal would leave the panel showing part of what was asked with nothing
   * saying which part failed.
   */
  const addEach = async ([first, ...rest]: readonly number[]): Promise<Jolli.SessionShare | undefined> => {
    if (first === undefined) return undefined
    const result = await add(first)
    if (result.status !== "ok" || rest.length === 0) return result
    return addEach(rest)
  }
  const shareMany = (userIds: readonly number[]) => write.mutate(() => addEach(userIds))

  const unshare = (subject: Jolli.ShareSubject) =>
    write.mutate(() =>
      serverSDK()
        .client.jolli.shareRemove({ sessionID: props.sessionID, subject: String(subject) }, { throwOnError: true })
        .then((response) => apply(response.data as Jolli.SessionShare)),
    )

  const busy = () => write.isPending || query.isFetching
  const code = () => (query.data ? courseLabel(language, query.data) : language.t("session.share.thisCourse"))
  const readers = () => query.data?.readers ?? []
  const candidates = createMemo(() => shareCandidates(query.data?.members ?? [], readers()))
  const matched = createMemo(() => matchCandidates(candidates(), state.search))
  const classShared = () => readers().some((reader) => reader.kind === "class")

  const closePicker = () => setState({ picking: false, search: "" })
  const pick = (run: () => void) => {
    run()
    closePicker()
  }

  return (
    <div class="flex w-full flex-col" data-component="session-share-panel">
      <SectionLabel>{language.t("session.share.inThisSession")}</SectionLabel>
      <div class="flex flex-col gap-1 px-1.5 py-2">
        <YouRow />
        {/*
         * ⚠ THE ASSISTANT IS A ROW OF WHO THE SESSION IS WITH, LAST, AND WITH NOTHING TO REMOVE. It was
         * not let in by anybody — it is half of what the session is — so it sits beside the student
         * and never under "Who can read it".
         */}
        <Show when={binding.assistant()}>{(assistant) => <AssistantRow assistant={assistant()} />}</Show>
      </div>

      <SectionLabel divided action={<ShareHelp code={code()} />}>
        {language.t("session.share.whoCanRead")}
      </SectionLabel>
      <div class="flex flex-col gap-1 px-1.5 pb-3 pt-2">
        <Switch>
          <Match when={query.isPending}>
            <Note>{language.t("session.share.loading")}</Note>
          </Match>
          <Match when={query.isError || query.data?.status === "unreachable"}>
            <div class="flex flex-col items-start gap-2">
              <Note>{language.t("session.share.unreachable")}</Note>
              <button
                type="button"
                class="rounded-[6px] px-1.5 py-0.5 text-[12px] font-[530] text-v2-text-text-accent hover:bg-v2-overlay-simple-overlay-hover"
                onClick={() => void query.refetch()}
              >
                {language.t("session.share.retry")}
              </button>
            </div>
          </Match>
          {/*
           * ⚠ A SESSION THE GATEWAY HAS NOT SEEN YET HAS NOTHING THERE TO SHARE. Its first model call
           * opens the conversation on Jolli, so the honest instruction is to send something first —
           * not a disabled picker that looks broken.
           */}
          <Match when={query.data?.status === "unsynced"}>
            <Note>{language.t("session.share.unsynced")}</Note>
          </Match>
          <Match when={query.data}>
            {(data) => (
              <div class="flex w-full flex-col gap-1">
                <Show when={readers().length > 0} fallback={<Note>{language.t("session.share.noReaders")}</Note>}>
                  <For each={readers()}>
                    {(reader) => <ReaderRow reader={reader} code={code()} busy={busy()} onRemove={unshare} />}
                  </For>
                </Show>

                {/*
                 * ⚠ A SESSION IN NO COURSE GETS ITS OWN SENTENCE. Sharing names people out of a course
                 * roster; with no roster there is nobody to name, and "everyone can already read it"
                 * over a private session would be alarming and false.
                 */}
                <Show when={data().courseId !== null} fallback={<Note>{language.t("session.share.noCourse")}</Note>}>
                  {/* Three ways to have nobody to offer, worded apart — see `pickerState`. */}
                  <Show
                    when={pickerState(data(), candidates()) === "pick"}
                    fallback={
                      <Switch>
                        <Match when={pickerState(data(), candidates()) === "roster-unavailable"}>
                          <div class="flex flex-col items-start gap-1">
                            <Note>{language.t("session.share.picker.rosterUnavailable", { code: code() })}</Note>
                            <button
                              type="button"
                              class="rounded-[6px] px-1.5 py-0.5 text-[12px] font-[530] text-v2-text-text-accent hover:bg-v2-overlay-simple-overlay-hover"
                              onClick={() => void query.refetch()}
                            >
                              {language.t("session.share.retry")}
                            </button>
                          </div>
                        </Match>
                        <Match when={pickerState(data(), candidates()) === "nobody-else"}>
                          <Note>{language.t("session.share.picker.nobodyElse", { code: code() })}</Note>
                        </Match>
                        <Match when={true}>
                          <Note>{language.t("session.share.picker.exhausted")}</Note>
                        </Match>
                      </Switch>
                    }
                  >
                    <button
                      type="button"
                      disabled={busy()}
                      aria-expanded={state.picking}
                      onClick={() => (state.picking ? closePicker() : setState("picking", true))}
                      class="mt-1 flex w-full items-center gap-2.5 rounded-[6px] px-1.5 py-1.5 text-left text-[13px] text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base disabled:opacity-50"
                      data-action="session-share-open-picker"
                    >
                      <span class="flex size-6 shrink-0 items-center justify-center rounded-full border border-dashed border-v2-border-border-base">
                        <IconV2 name="plus" size="small" />
                      </span>
                      {language.t("session.share.picker.open")}
                    </button>
                    <Show when={state.picking}>
                      {/* `data-share-dismissable` is how the popover knows an Escape in here is the card's, not the panel's. */}
                      <div
                        data-share-dismissable
                        class="flex w-full flex-col overflow-hidden rounded-[8px] border border-v2-border-border-base"
                      >
                        <div class="flex items-center gap-1.5 border-b border-v2-border-border-base p-1.5">
                          {/* `!`: the input's own stylesheet pins it at `width: 280px; flex: none`, wider than this card. */}
                          <TextInputV2
                            class="w-auto! min-w-0 flex-1!"
                            // `autofocus` only fires on page load; this input mounts on demand.
                            ref={(element) => requestAnimationFrame(() => element.focus())}
                            value={state.search}
                            leadingIcon={<IconV2 name="magnifying-glass" size="small" />}
                            placeholder={language.t("session.share.picker.search", { code: code() })}
                            onInput={(event) => setState("search", event.currentTarget.value)}
                            onKeyDown={(event) => {
                              if (event.key !== "Escape") return
                              // Put the card away, not the panel it sits in — see `data-share-dismissable`.
                              event.preventDefault()
                              closePicker()
                            }}
                          />
                          <IconButtonV2
                            type="button"
                            size="small"
                            variant="ghost-muted"
                            icon={<IconV2 name="close" />}
                            aria-label={language.t("session.share.picker.close")}
                            onClick={closePicker}
                          />
                        </div>
                        <div class="flex max-h-64 flex-col gap-1 overflow-y-auto p-1">
                          <Show
                            when={matched().length > 0}
                            fallback={<Note>{language.t("session.share.picker.empty", { code: code() })}</Note>}
                          >
                            {/* Staff lead: a student scanning this list is usually after the one name they are sure of. */}
                            <CandidateGroup
                              label={language.t("session.share.picker.staff")}
                              candidates={matched().filter((candidate) => candidate.kind === "staff")}
                              busy={busy()}
                              onPick={(userId) => pick(() => share(userId))}
                              bulk={{
                                label: language.t("session.share.picker.allStaff"),
                                onPick: () =>
                                  pick(() =>
                                    shareMany(
                                      matched()
                                        .filter((candidate) => candidate.kind === "staff")
                                        .map((candidate) => candidate.userId),
                                    ),
                                  ),
                              }}
                            />
                            {/*
                             * ⚠ "ALL N STUDENTS" WRITES THE CLASS-WIDE GRANT, not one row per student:
                             * one standing grant that admits whoever joins later. It disappears once the
                             * course holds it, because there is only ever one.
                             */}
                            <CandidateGroup
                              label={language.t("session.share.picker.students")}
                              candidates={matched().filter((candidate) => candidate.kind === "student")}
                              busy={busy()}
                              onPick={(userId) => pick(() => share(userId))}
                              bulk={
                                classShared()
                                  ? undefined
                                  : {
                                      label: language.plural("session.share.picker.allStudents", data().classSize),
                                      onPick: () => pick(() => share(EVERYONE)),
                                    }
                              }
                            />
                          </Show>
                        </div>
                      </div>
                    </Show>
                  </Show>
                </Show>

                <Show when={state.refusal}>
                  {(refusal) => (
                    <div class="px-1.5 pt-1 text-[12px] leading-snug text-v2-state-fg-danger" role="alert">
                      {language.t(REFUSAL_KEYS[refusal()])}
                    </div>
                  )}
                </Show>
              </div>
            )}
          </Match>
        </Switch>
      </div>
    </div>
  )
}

/**
 * ⚠ EVERY REFUSAL IS A SENTENCE THE STUDENT CAN ACT ON, and the fallback is a sentence too — never
 * the code.
 */
const REFUSAL_KEYS = {
  subject_not_in_course: "session.share.refusal.subjectNotInCourse",
  subject_is_owner: "session.share.refusal.subjectIsOwner",
  conversation_has_no_course: "session.share.refusal.noCourse",
  access_not_writable: "session.share.refusal.accessNotWritable",
  unknown: "session.share.refusal.unknown",
} as const satisfies Record<Jolli.ShareRefusal, string>

function Note(props: { children: string }) {
  return <div class="px-1.5 py-1 text-[13px] leading-5 text-v2-text-text-muted">{props.children}</div>
}

/**
 * ONE BAND'S HEADING, AND THE RULE THAT SEPARATES IT FROM THE BAND ABOVE — the web's `SectionLabel`.
 * Two lists of names under one border read as one list, so each band gets its own.
 */
function SectionLabel(props: { children: string; action?: JSX.Element; divided?: boolean }) {
  return (
    <div
      class="relative flex items-center gap-1.5 border-v2-border-border-base px-3 py-2.5"
      classList={{ "border-t": props.divided, "border-b": !props.divided }}
    >
      <span class="select-none text-[11px] font-[530] uppercase tracking-wide text-v2-text-text-muted">
        {props.children}
      </span>
      {props.action}
    </div>
  )
}

/** A heading inside the picker card: a label, never a band. */
function GroupLabel(props: { children: string }) {
  return (
    <div class="select-none text-[11px] font-[530] uppercase tracking-wide text-v2-text-text-faint">
      {props.children}
    </div>
  )
}

/**
 * A PERSON'S CIRCLE: their initials on a neutral fill, as the web's `UserAvatar` draws them.
 *
 * ⚠ DRAWN HERE RATHER THAN WITH `Avatar`, which shows one letter. The web shows two ("SL"), and two
 * people called Sam in one course are exactly who a picker needs to tell apart.
 */
function PersonCircle(props: { name: string }) {
  return (
    <span class="flex size-6 shrink-0 select-none items-center justify-center rounded-full border border-v2-border-border-base bg-v2-background-bg-layer-02 text-[10px] font-[530] text-v2-text-text-base">
      {initials(props.name)}
    </span>
  )
}

/**
 * THE STUDENT, AS THE FIRST ROW OF WHO THE SESSION IS WITH.
 *
 * ⚠ THE NAME, AND "YOU" BESIDE IT RATHER THAN INSTEAD OF IT — the web's rule. Only when the token
 * names nobody does "You" stand in for the name, and then it is not repeated beside it.
 */
function YouRow() {
  const language = useLanguage()
  const name = () => viewer()?.name ?? viewer()?.email
  return (
    <div class="flex min-w-0 items-center gap-2.5 px-1.5 py-1" data-component="session-share-participant">
      <PersonCircle name={name() ?? language.t("session.share.you")} />
      <span class="min-w-0 flex-1 truncate text-[13px] text-v2-text-text-base">
        {name() ?? language.t("session.share.you")}
      </span>
      <Show when={name()}>
        <span class="shrink-0 text-[12px] text-v2-text-text-muted">{language.t("session.share.you")}</span>
      </Show>
    </div>
  )
}

/**
 * THE ASSISTANT'S MARK: its glyph, white, on its own accent — how the web dresses an assistant in
 * its share panel. The glyph is the professor's pick, drawn from the same set the course bar uses
 * (`assistantIconName`).
 *
 * ⚠ DRESSED UNLIKE A PERSON ON PURPOSE. People wear neutral initials; an assistant drawn the same
 * way would read as one more classmate with an unusually long name.
 *
 * ⚠ THE WHITE IS INLINE BECAUSE `text-white` DOES NOT EXIST HERE. The Tailwind theme resets the
 * palette (`--color-*: initial` in `ui/src/styles/tailwind/colors.css`), so the class emits nothing
 * and the glyph would inherit the surrounding dark text. The size class overrides the icon's own
 * `width`/`height` attributes, which only come in 14, 16 and 20.
 */
function AssistantMark(props: { assistant: Assistant }) {
  return (
    <span
      class="flex size-6 shrink-0 items-center justify-center rounded-full"
      style={{ background: `var(--dataviz-cat-${props.assistant.accent})`, color: "#fff" }}
      aria-hidden="true"
    >
      <IconV2 name={assistantIconName(props.assistant.icon)} class="size-3" />
    </span>
  )
}

function AssistantRow(props: { assistant: Assistant }) {
  return (
    <div class="flex min-w-0 items-center gap-2.5 px-1.5 py-1" data-component="session-share-assistant">
      <AssistantMark assistant={props.assistant} />
      <span class="min-w-0 flex-1 truncate text-[13px] text-v2-text-text-base">{props.assistant.name}</span>
    </div>
  )
}

/**
 * WHO THE SESSION IS WITH, AS OVERLAPPING CIRCLES AND A NAME — the web header's share trigger.
 *
 * ⚠ THE ASSISTANT SITS UNDERNEATH: last in reading order (a session is the student, then what
 * answered them) and first in depth, so the overlap eats into the assistant's circle rather than a
 * person's face. `relative` on the person is what lifts it over the circle after it.
 */
export function ParticipantStack(props: { assistant: Assistant }) {
  const language = useLanguage()
  const name = () => viewer()?.name ?? viewer()?.email ?? language.t("session.share.you")
  return (
    <span class="flex min-w-0 items-center gap-2">
      <span class="flex shrink-0 items-center">
        <span class="relative rounded-full bg-v2-background-bg-base">
          <PersonCircle name={name()} />
        </span>
        <span class="-ml-1.5">
          <AssistantMark assistant={props.assistant} />
        </span>
      </span>
      <span class="min-w-0 truncate text-[13px] text-v2-text-text-muted">{props.assistant.name}</span>
    </span>
  )
}

/**
 * THE "?" BESIDE "WHO CAN READ IT", AND THE TWO SENTENCES BEHIND IT — the web's `ChatSharingHelp`.
 *
 * ⚠ THE RULE ABOUT WHO MAY BE ADDED LIVES HERE, not at the foot of the picker: stated where the
 * question is asked it is read, stated under a list somebody is scrolling it is furniture.
 *
 * ⚠ IT ANSWERS TO HOVER, AND A PRESS ONLY EVER SHOWS IT — a keyboard's way in. The card hangs inside
 * the hover region (the gap above it is padding, not margin), so moving onto it never takes it away.
 *
 * ⚠ AN ABSOLUTE CARD, NOT A NESTED POPOVER, for the picker's reason. While it is up it carries
 * `data-share-dismissable`, which is how the panel's popover knows the next Escape is the card's.
 */
function ShareHelp(props: { code: string }) {
  const language = useLanguage()
  const [help, setHelp] = createStore({ shown: false })
  /**
   * ⚠ HIDING WAITS A MOMENT, AND RE-ENTERING CANCELS IT. The card spans the band rather than hanging
   * directly off the "?", so the pointer crosses a strip of band on its way down; without the grace
   * period that strip would take the card away from somebody reaching for it.
   */
  let hide: ReturnType<typeof setTimeout> | undefined
  const show = () => {
    clearTimeout(hide)
    setHelp("shown", true)
  }
  const leave = () => {
    clearTimeout(hide)
    hide = setTimeout(() => setHelp("shown", false), 150)
  }
  onCleanup(() => clearTimeout(hide))
  return (
    <span
      class="flex"
      data-share-dismissable={help.shown ? "" : undefined}
      onPointerEnter={show}
      onPointerLeave={leave}
      onKeyDown={(event) => {
        if (event.key === "Escape" && help.shown) setHelp("shown", false)
      }}
    >
      <button
        type="button"
        aria-label={language.t("session.share.help.open")}
        aria-expanded={help.shown}
        onClick={show}
        onBlur={() => setHelp("shown", false)}
        class="flex size-4 shrink-0 cursor-help items-center justify-center rounded-full border border-v2-border-border-base text-[10px] font-[530] text-v2-text-text-muted hover:text-v2-text-text-base"
      >
        ?
      </button>
      <Show when={help.shown}>
        {/* Spans the band rather than hanging off the "?", so it never spills past the panel's edge. */}
        <span class="absolute inset-x-3 top-full z-50 -mt-1">
          <span class="flex flex-col gap-2.5 rounded-[8px] border border-v2-border-border-base bg-v2-background-bg-layer-01 p-3 text-[12px] leading-relaxed text-v2-text-text-muted shadow-[var(--v2-elevation-floating)]">
            <span class="flex gap-2">
              <IconV2 name="eye-off" size="small" class="mt-0.5 shrink-0" />
              <span class="min-w-0 flex-1">{language.t("session.share.help.startsPrivate")}</span>
            </span>
            <span class="flex gap-2">
              <IconV2 name="user" size="small" class="mt-0.5 shrink-0" />
              <span class="min-w-0 flex-1">{language.t("session.share.onlyThisCourse", { code: props.code })}</span>
            </span>
          </span>
        </span>
      </Show>
    </span>
  )
}

/**
 * ONE ROW UNDER "WHO CAN READ IT" — a person, or the whole course.
 *
 * ⚠ THE CLASS ROW IS SHAPED LIKE A PERSON'S, because it is withdrawn the same way; a grant you take
 * back with a different gesture is one people hesitate over. Its circle is a glyph rather than an
 * initial, so it does not read as one more classmate with an unusually long name.
 *
 * ⚠ THE LEVEL IS A READ-OUT, NOT A CONTROL. There is one level to offer, and a greyed-out second
 * option would be a promise in a different costume.
 */
function ReaderRow(props: {
  reader: Jolli.SessionReader
  code: string
  busy: boolean
  onRemove: (subject: Jolli.ShareSubject) => void
}) {
  const language = useLanguage()
  const person = () => (props.reader.kind === "person" ? props.reader : undefined)
  const name = () => person()?.name ?? language.t("session.share.classRow.name", { code: props.code })
  const detail = () => {
    const reader = props.reader
    if (reader.kind === "class") return language.plural("session.share.classRow.detail", reader.classSize)
    return reader.detail
  }
  return (
    <div class="flex min-w-0 items-center gap-2.5 px-1.5 py-1" data-component="session-share-reader">
      <Show
        when={person()}
        fallback={
          <span class="flex size-6 shrink-0 items-center justify-center rounded-full bg-v2-background-bg-layer-03 text-v2-icon-icon-muted">
            <IconV2 name="user" size="small" />
          </span>
        }
      >
        {(reader) => <PersonCircle name={reader().name} />}
      </Show>
      <span class="min-w-0 flex-1">
        <span class="block truncate text-[13px] text-v2-text-text-base">{name()}</span>
        <Show when={detail()}>
          {(text) => <span class="block truncate text-[12px] text-v2-text-text-muted">{text()}</span>}
        </Show>
      </span>
      <span class="shrink-0 text-[12px] text-v2-text-text-muted">
        {language.t(props.reader.access === "comment" ? "session.share.access.comment" : "session.share.access.view")}
      </span>
      <IconButtonV2
        type="button"
        size="small"
        variant="ghost-muted"
        icon={<IconV2 name="close" />}
        disabled={props.busy}
        aria-label={
          person() ? language.t("session.share.remove", { name: name() }) : language.t("session.share.removeClass")
        }
        onClick={() => props.onRemove(person()?.userId ?? EVERYONE)}
      />
    </div>
  )
}

/**
 * ONE GROUP OF THE PICKER, WITH ITS ONE-PRESS ACTION ON THE HEADING ROW.
 *
 * ⚠ THE ADDRESS IS SEARCHED BUT NEVER DRAWN. A column of classmates' email addresses is a roster of
 * the course, and the panel that shares one session is not the place to hand one out.
 */
function CandidateGroup(props: {
  label: string
  candidates: readonly Jolli.ShareMember[]
  busy: boolean
  onPick: (userId: number) => void
  bulk: { label: string; onPick: () => void } | undefined
}) {
  const language = useLanguage()
  const shown = () => props.candidates.slice(0, RENDER_CAP)
  const hidden = () => props.candidates.length - shown().length
  return (
    <Show when={props.candidates.length > 0}>
      <div class="flex flex-col gap-0.5">
        <div class="flex items-center justify-between gap-2 px-1.5 pt-1">
          <GroupLabel>{props.label}</GroupLabel>
          <Show when={props.bulk}>
            {(bulk) => (
              <button
                type="button"
                disabled={props.busy}
                onClick={() => bulk().onPick()}
                class="shrink-0 rounded-[6px] px-1 py-0.5 text-[12px] font-[530] text-v2-text-text-accent hover:bg-v2-overlay-simple-overlay-hover disabled:opacity-50"
              >
                {bulk().label}
              </button>
            )}
          </Show>
        </div>
        <For each={shown()}>
          {(candidate) => (
            <button
              type="button"
              disabled={props.busy}
              title={language.t("session.share.picker.shareWith", { name: candidate.name })}
              onClick={() => props.onPick(candidate.userId)}
              class="flex min-w-0 items-center gap-2.5 rounded-[6px] px-1.5 py-1.5 text-left hover:bg-v2-overlay-simple-overlay-hover disabled:opacity-50"
              data-component="session-share-candidate"
            >
              <PersonCircle name={candidate.name} />
              <span class="min-w-0 flex-1 truncate text-[13px] text-v2-text-text-base">{candidate.name}</span>
            </button>
          )}
        </For>
        {/* The hidden count is drawn, so a capped list never reads as the whole course. */}
        <Show when={hidden() > 0}>
          <div class="px-1.5 pt-1 text-[12px] text-v2-text-text-faint">
            {language.plural("session.share.picker.more", hidden())}
          </div>
        </Show>
      </div>
    </Show>
  )
}
