/**
 * WHO CAN READ A SESSION ON JOLLI, AND THE CONTROL THAT CHANGES IT.
 *
 * Ported from jolliedu's `ChatSharePanel`, `ChatSharePicker`, `ChatSharingHelp` and the share button
 * of `ChatHeader`, and it replaces upstream's "Publish on web" popover in the same slot. Upstream
 * published a transcript to a public link on a third party's servers; this names people in the
 * session's course on the student's own Jolli account, so a reader is always somebody the student
 * can name.
 *
 * ⚠ THE SIDECAR HOLDS THE CREDENTIAL, NOT THIS COMPONENT. Every read and write goes through
 * `/jolli/session/:sessionID/share`, which answers with one composed shape. After a write the
 * readers are replaced wholesale from that answer (`applyWrite`) — jolliedu's rule, so the panel
 * never holds a second opinion about who can read.
 *
 * ⚠ IT SHARES ITS CACHE ENTRY WITH THE COACHING GATE, AND THE HEADER'S BUTTON FOLLOWS IT
 * (`use-session-share.ts`), so a write here reaches both at once. It is mounted from the header —
 * the share button and "Share…" — and is the same panel from either.
 *
 * ⚠ LAID OUT AS THE WEB'S PANEL IS, BAND FOR BAND — a shared document's dialog: a field to add
 * people at the top, the people with access beneath it with the owner first, and what answered the
 * session as the footer. The web calls it a chat; this product calls it a session, which is the one
 * deliberate difference in the wording.
 *
 * ⚠ NOTHING IN HERE IS A NESTED POPOVER — the search results, the access menu and the "?" card are
 * all ordinary content of the panel. jolliedu's reason: a second popover mounts in its own portal,
 * takes focus there, and the panel reads that as focus leaving and dismisses itself. Each carries
 * its own way out instead, and claims Escape before the panel can (`useInnerLayerEscape`).
 */

import type { Jolli } from "@opencode-ai/schema/jolli"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { useMutation } from "@tanstack/solid-query"
import {
  createEffect,
  createMemo,
  createUniqueId,
  For,
  Index,
  type JSX,
  Match,
  onCleanup,
  Show,
  Switch,
} from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { assistantIconName } from "@/jolli/assistant-icon"
import { viewer } from "@/jolli/catalog"
import { useCourseSession } from "@/jolli/session-binding"
import {
  initials,
  matchCandidates,
  pickerState,
  RENDER_CAP,
  shareCandidates,
  writeRefusal,
} from "@/jolli/session-share"
import type { Assistant } from "@/jolli/types"
import {
  courseLabel,
  shareAnswer,
  useApplyShareWrite,
  useSessionReaders,
  useSessionShare,
} from "@/jolli/use-session-share"

const EVERYONE = "everyone"

/**
 * A ROW OF THE ACCESS LIST. The hover wash runs to the panel's padding and the row is pulled out by
 * the same amount, so the circle and the name stay aligned with the heading above.
 */
const ROW_CLASS =
  "-mx-2 flex min-w-0 items-center gap-3 rounded-[6px] px-2 py-1 transition-colors hover:bg-v2-overlay-simple-overlay-hover"

export function SessionSharePanel(props: { sessionID: string; ref: (element: HTMLDivElement) => void }) {
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const binding = useCourseSession()
  const [state, setState] = createStore({ refusal: undefined as Jolli.ShareRefusal | undefined })

  const query = useSessionShare(() => props.sessionID, { fresh: true })
  const answer = () => shareAnswer(query)

  /**
   * ⚠ EVERY WRITE'S ANSWER IS APPLIED AS IT LANDS, including the ones inside a bulk run, so a run
   * refused halfway still shows the grants that did land beside the refusal that stopped it.
   */
  const apply = useApplyShareWrite(() => props.sessionID)
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

  /**
   * ⚠ EVERY WRITE PARKS FOCUS ON THE PANEL BEFORE IT STARTS. The control that asked for it — a
   * candidate, "Remove access" — is gone by the time the answer lands, and focus dropped to `body`
   * lets the session's type-to-focus send the next keystroke to the composer, which the popover
   * reads as focus leaving and closes on.
   *
   * ⚠ AND NONE STARTS WHILE THE PANEL IS BUSY, whichever control asked. A disabled control is not the
   * guard: an access menu opened before a request began stays usable through it, and two writes in
   * flight would race for the refusal and land their answers in either order.
   */
  let root: HTMLDivElement | undefined
  const run = (task: () => Promise<Jolli.SessionShare | undefined>) => {
    if (busy()) return
    root?.focus({ preventScroll: true })
    write.mutate(task)
  }

  const share = (subject: Jolli.ShareSubject) => run(() => add(subject))

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
  const shareMany = (userIds: readonly number[]) => run(() => addEach(userIds))

  const unshare = (subject: Jolli.ShareSubject) =>
    run(() =>
      serverSDK()
        .client.jolli.shareRemove({ sessionID: props.sessionID, subject: String(subject) }, { throwOnError: true })
        .then((response) => apply(response.data as Jolli.SessionShare)),
    )

  const busy = () => write.isPending || query.isFetching
  const code = () => courseLabel(language, answer())
  const readers = () => answer()?.readers ?? []
  const candidates = createMemo(() => shareCandidates(answer()?.members ?? [], readers()))
  const picker = createMemo(() => {
    const data = answer()
    return data ? pickerState(data, candidates()) : undefined
  })
  const retry = () => void query.refetch()

  const accessList = (help = true) => (
    <AccessList
      readers={readers()}
      code={code()}
      help={help}
      busy={busy()}
      refusal={state.refusal}
      onRemove={unshare}
    />
  )

  return (
    <div
      ref={(element) => {
        root = element
        props.ref(element)
      }}
      // Focusable but out of the tab order: where opening, and every write, park focus inside the panel.
      tabIndex={-1}
      class="flex w-full flex-col outline-none"
      data-component="session-share-panel"
    >
      <Switch>
        <Match when={query.isPending}>
          <Note class="pb-4">{language.t("session.share.loading")}</Note>
        </Match>
        <Match when={query.isError || answer()?.status === "unreachable"}>
          <div class="flex flex-col items-start pb-3">
            <Note>{language.t("session.share.unreachable")}</Note>
            <Retry onClick={retry} />
          </div>
        </Match>
        {/*
         * ⚠ A SESSION THE GATEWAY HAS NOT SEEN YET, AND ONE IN NO COURSE, GET A SENTENCE WHERE THE
         * FIELD WOULD BE. The first has nothing on Jolli to share until its first model call opens the
         * conversation there; the second has no roster to name anybody out of, and a field that could
         * only answer "nobody matches that" would be a control that does nothing. Nobody else can read
         * either, so the owner's row beneath the sentence is the truth.
         */}
        <Match when={answer()?.status === "unsynced"}>
          <Note>{language.t("session.share.unsynced")}</Note>
          {accessList()}
        </Match>
        <Match when={answer()?.courseId === null}>
          <Note>{language.t("session.share.noCourse")}</Note>
          {/* No "?": its rule is who in the course may be added, beside a sentence saying there is no course. */}
          {accessList(false)}
        </Match>
        <Match when={answer()}>
          {(data) => (
            <Show
              when={picker() === "pick"}
              fallback={
                <>
                  {/* Three ways to have nobody to offer, worded apart — see `pickerState`. */}
                  <Switch>
                    <Match when={picker() === "roster-unavailable"}>
                      <div class="flex flex-col items-start">
                        <Note>{language.t("session.share.picker.rosterUnavailable", { code: code() })}</Note>
                        <Retry onClick={retry} />
                      </div>
                    </Match>
                    <Match when={picker() === "nobody-else"}>
                      <Note>{language.t("session.share.picker.nobodyElse", { code: code() })}</Note>
                    </Match>
                    <Match when={true}>
                      <Note>{language.t("session.share.picker.exhausted")}</Note>
                    </Match>
                  </Switch>
                  {accessList()}
                </>
              }
            >
              <SharePicker
                candidates={candidates()}
                code={code()}
                classSize={data().classSize}
                classShared={readers().some((reader) => reader.kind === "class")}
                busy={busy()}
                onPick={share}
                onPickMany={shareMany}
                onPickEveryone={() => share(EVERYONE)}
              >
                {accessList()}
              </SharePicker>
            </Show>
          )}
        </Match>
      </Switch>
      <Show when={binding.assistant()}>{(assistant) => <AssistantFooter assistant={assistant()} />}</Show>
    </div>
  )
}

/**
 * THE SHARE BUTTON IN THE SESSION HEADER — the web header's share trigger, drawn the same way: the
 * people's circles, the owner first and then whoever they let in, and then `Share` or `Sharing`.
 *
 * ⚠ PEOPLE ONLY — NEVER THE ASSISTANT. Which assistant answers is stated above the composer by
 * `SessionCourseBar`; a circle for it here would put something that answered the session into the
 * control that says who can read it.
 *
 * ⚠ THE CLASS GRANT SWALLOWS THE NAMED READERS. A session the course can read is readable by
 * everybody a named reader could have added, so the button draws one circle for the class instead of
 * a row of faces that would understate who can read it.
 *
 * ⚠ IT ASKS FOR EVERY SESSION IT SHOWS, SO IT ASKS THE CHEAP READ. The word is the whole state, so it
 * cannot wait for the panel to open; `useSessionReaders` reads who can read the session without the
 * timeline or the roster, and takes in every answer the panel's own read brings back.
 */
export function SessionShareTrigger(props: {
  sessionID: string
  open: boolean
  ref: (element: HTMLButtonElement) => void
  onClick: () => void
}) {
  const language = useLanguage()
  const answer = useSessionReaders(() => props.sessionID)
  const readers = () => answer()?.readers ?? []
  const shared = () => readers().length > 0
  const classShared = () => readers().some((reader) => reader.kind === "class")
  const code = () => courseLabel(language, answer())
  const faces = createMemo(() => [
    viewer()?.name ?? viewer()?.email ?? language.t("session.share.you"),
    ...(classShared() ? [] : readers().flatMap((reader) => (reader.kind === "person" ? [reader.name] : []))),
  ])
  /**
   * ⚠ FIVE SLOTS, AND THE COUNT TAKES ONE OF THEM: past five faces the button draws four and a `+N`,
   * so a session shared with thirty people is exactly as wide as one shared with five.
   */
  const shown = () => (faces().length > 5 ? faces().slice(0, 4) : faces())
  const hidden = () => faces().length - shown().length

  return (
    <button
      type="button"
      ref={props.ref}
      aria-label={language.t(shared() ? "session.share.trigger.sharing" : "session.share.trigger.share")}
      aria-expanded={props.open}
      onClick={props.onClick}
      class="flex shrink-0 items-center gap-2 rounded-[6px] px-2 py-1 text-[13px] font-[530] text-v2-text-text-base hover:bg-v2-overlay-simple-overlay-hover"
      classList={{ "bg-v2-overlay-simple-overlay-hover": props.open }}
      data-action="session-share-trigger"
    >
      <span class="flex -space-x-1" aria-hidden="true">
        <Index each={shown()}>
          {(face) => (
            <span class="relative rounded-full ring-2 ring-v2-background-bg-base">
              <PersonCircle name={face()} small />
            </span>
          )}
        </Index>
        {/* Under the faces, which are `relative` and this is not: the overlap eats into the count, not into somebody's face. */}
        <Show when={hidden() > 0}>
          <span class="flex h-5 min-w-5 items-center justify-center rounded-full bg-v2-background-bg-layer-03 px-1 text-[9px] font-[530] text-v2-text-text-muted ring-2 ring-v2-background-bg-base">
            +{hidden()}
          </span>
        </Show>
        <Show when={classShared()}>
          <span
            class="flex size-5 items-center justify-center rounded-full bg-v2-background-bg-layer-03 text-v2-icon-icon-muted ring-2 ring-v2-background-bg-base"
            title={language.t("session.share.classRow.name", { code: code() })}
          >
            <IconV2 name="assistant-users" class="size-2.5" />
          </span>
        </Show>
      </span>
      {/* `Share` is the offer on a private session, `Sharing` once somebody else can read it. */}
      <span>{language.t(shared() ? "session.share.sharing" : "session.share.action.share")}</span>
    </button>
  )
}

/**
 * LETS ESCAPE CLOSE A LAYER DRAWN INSIDE THE PANEL — the search results, an access menu, the "?"
 * card — WITHOUT ALSO CLOSING THE PANEL. jolliedu's `useInnerLayerEscape`.
 *
 * ⚠ ON `window`, IN THE CAPTURE PHASE, AND BY `preventDefault`. Kobalte listens for Escape on
 * `document`, and the header's popover leaves an event that arrives already default-prevented to the
 * layer that claimed it. Window capture is the one place that runs before Kobalte; a handler on the
 * layer itself would run after the panel had already been dismissed. A second Escape, with the layer
 * shut, closes the panel as usual.
 *
 * ⚠ AN ESCAPE THAT CANCELS AN IME COMPOSITION IS CLAIMED BUT NOT ACTED ON. It belongs to the input
 * method, which is discarding a candidate in the search field; left unclaimed, the panel would read
 * it as its own and close instead.
 */
function useInnerLayerEscape(open: () => boolean, onEscape: () => void) {
  createEffect(() => {
    if (!open()) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return
      event.preventDefault()
      if (event.isComposing || event.keyCode === 229) return
      onEscape()
    }
    window.addEventListener("keydown", onKeyDown, { capture: true })
    onCleanup(() => window.removeEventListener("keydown", onKeyDown, { capture: true }))
  })
}

/**
 * WHO THE SESSION MAY BE SHARED WITH: A SEARCH FIELD AT THE TOP OF THE PANEL, the way a shared
 * document's dialog opens on "Add people".
 *
 * ⚠ ALWAYS VISIBLE, AND THE RESULTS REPLACE THE PANEL'S LIST RATHER THAN FLOATING OVER IT. Adding
 * somebody is the panel's main action, so it leads. Pressing into the field swaps the people with
 * access for the candidates; Escape, the close control, or a pick puts them back.
 *
 * ⚠ IT OPENS ON FOCUS AS WELL AS ON PRESS, so a keyboard user tabbing in gets the list without a
 * second step. The header parks the panel's opening focus on its box rather than here, so merely
 * opening the panel never throws the results over the people with access.
 */
function SharePicker(props: {
  candidates: readonly Jolli.ShareMember[]
  code: string
  classSize: number
  classShared: boolean
  busy: boolean
  onPick: (userId: number) => void
  onPickMany: (userIds: readonly number[]) => void
  onPickEveryone: () => void
  children: JSX.Element
}) {
  const language = useLanguage()
  const [picker, setPicker] = createStore({ open: false, search: "" })
  const results = createUniqueId()
  let field: HTMLInputElement | undefined
  const close = () => setPicker({ open: false, search: "" })
  /**
   * PUTS THE LIST AWAY AND LEAVES FOCUS IN THE FIELD — for Escape and the close control, either of
   * which may fire from a control inside the list that is about to go.
   *
   * ⚠ FOCUSED FIRST, THEN CLOSED. The field opens the list on focus, so the other order would open
   * it again at once.
   */
  const dismiss = () => {
    field?.focus()
    close()
  }
  const pick = (run: () => void) => {
    run()
    close()
  }
  useInnerLayerEscape(() => picker.open, dismiss)
  const matched = createMemo(() => matchCandidates(props.candidates, picker.search))
  const staff = () => matched().filter((candidate) => candidate.kind === "staff")
  const students = () => matched().filter((candidate) => candidate.kind === "student")
  const label = () => language.t("session.share.picker.addPeople", { code: props.code })

  return (
    <div class="flex flex-col">
      <div class="px-4 pt-4">
        {/*
         * `!`: the input's own stylesheet pins it at `width: 280px; flex: none`, narrower than the panel.
         * Its clear control is the list's close control; it keeps focus in the field on press.
         *
         * ⚠ A NAMED FIELD THAT CONTROLS THE LIST, NOT A `combobox`. That role promises arrow keys
         * through the results, and these are ordinary buttons reached with Tab.
         *
         * ⚠ NEVER DISABLED, NOT EVEN WHILE BUSY. `busy` includes the coaching gate's background read,
         * and disabling a focused field drops focus to `body` mid-word — outside the panel, where the
         * next keystroke goes to the composer and the popover closes. The candidates are what wait.
         */}
        <TextInputV2
          ref={field}
          appearance="large"
          class="w-full!"
          value={picker.search}
          leadingIcon={<IconV2 name="magnifying-glass" size="small" />}
          showClearButton={picker.open}
          clearLabel={language.t("session.share.picker.close")}
          onClearClick={dismiss}
          onFocus={() => setPicker("open", true)}
          onClick={() => setPicker("open", true)}
          onInput={(event) => setPicker({ search: event.currentTarget.value, open: true })}
          placeholder={label()}
          aria-label={label()}
          aria-controls={picker.open ? results : undefined}
          data-action="session-share-search"
        />
      </div>
      <Show when={picker.open} fallback={props.children}>
        <div
          id={results}
          class="flex max-h-80 flex-col gap-1 overflow-y-auto px-2 pb-3 pt-2.5"
          data-component="session-share-picker"
        >
          <Show
            when={matched().length > 0}
            fallback={
              <p class="px-2 text-[11px] leading-normal text-v2-text-text-muted">
                {language.t("session.share.picker.empty", { code: props.code })}
              </p>
            }
          >
            {/* Staff lead: a student scanning this list is usually after the one name they are sure of. */}
            <CandidateGroup
              label={language.t("session.share.picker.staff")}
              candidates={staff()}
              busy={props.busy}
              onPick={(userId) => pick(() => props.onPick(userId))}
              bulk={{
                label: language.t("session.share.picker.allStaff"),
                onPick: () => pick(() => props.onPickMany(staff().map((candidate) => candidate.userId))),
              }}
            />
            {/*
             * ⚠ "ALL N STUDENTS" WRITES THE CLASS-WIDE GRANT, not one row per student: one standing
             * grant that admits whoever joins later. It disappears once the course holds it, because
             * there is only ever one.
             */}
            <CandidateGroup
              label={language.t("session.share.picker.students")}
              candidates={students()}
              busy={props.busy}
              onPick={(userId) => pick(() => props.onPick(userId))}
              bulk={
                props.classShared
                  ? undefined
                  : {
                      label: language.plural("session.share.picker.allStudents", props.classSize),
                      onPick: () => pick(props.onPickEveryone),
                    }
              }
            />
          </Show>
        </div>
      </Show>
    </div>
  )
}

/**
 * THE PEOPLE WITH ACCESS, THE OWNER FIRST.
 *
 * ⚠ THE OWNER IS A ROW MARKED `Owner`, NOT A SECTION OF THEIR OWN — the answer a shared document gives
 * to "who has access". It means a private session's list is never empty: the owner alone IS the
 * private state, with no sentence needed to say so.
 */
function AccessList(props: {
  readers: readonly Jolli.SessionReader[]
  code: string
  help: boolean
  busy: boolean
  refusal: Jolli.ShareRefusal | undefined
  onRemove: (subject: Jolli.ShareSubject) => void
}) {
  const language = useLanguage()
  return (
    <>
      <Show when={props.refusal}>
        {(refusal) => (
          <p class="px-4 pt-2.5 text-[11px] leading-normal text-v2-state-fg-danger" role="alert">
            {language.t(REFUSAL_KEYS[refusal()])}
          </p>
        )}
      </Show>
      <div class="flex items-center gap-1.5 px-4 pb-1.5 pt-4">
        <span class="select-none text-[11px] font-[530] uppercase leading-normal tracking-wide text-v2-text-text-muted">
          {language.t("session.share.peopleWithAccess")}
        </span>
        <Show when={props.help}>
          <ShareHelp code={props.code} />
        </Show>
      </div>
      <div class="flex flex-col gap-1 px-4 pb-3">
        <OwnerRow />
        <For each={props.readers}>
          {(reader) => <ReaderRow reader={reader} code={props.code} busy={props.busy} onRemove={props.onRemove} />}
        </For>
      </div>
    </>
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

function Note(props: { children: string; class?: string }) {
  return (
    <p class={`px-4 pt-4 text-[11px] leading-normal text-v2-text-text-muted ${props.class ?? ""}`}>{props.children}</p>
  )
}

function Retry(props: { onClick: () => void }) {
  const language = useLanguage()
  return (
    <button
      type="button"
      class="mx-3 mt-1 rounded-[6px] px-1 py-0.5 text-[11px] font-[530] text-v2-text-text-accent hover:bg-v2-overlay-simple-overlay-hover"
      onClick={() => props.onClick()}
    >
      {language.t("session.share.retry")}
    </button>
  )
}

/**
 * A PERSON'S CIRCLE: their initials on a neutral fill, as the web's `UserAvatar` draws them.
 *
 * ⚠ DRAWN HERE RATHER THAN WITH `Avatar`, which shows one letter. The web shows two ("SL"), and two
 * people called Sam in one course are exactly who a picker needs to tell apart.
 */
function PersonCircle(props: { name: string; small?: boolean }) {
  return (
    <span
      class="flex shrink-0 select-none items-center justify-center rounded-full bg-v2-background-bg-layer-03 font-[530] text-v2-text-text-base"
      classList={{ "size-6 text-[12px]": !props.small, "size-5 text-[9px]": props.small }}
    >
      {initials(props.name)}
    </span>
  )
}

/**
 * THE OWNER, FIRST IN THE ACCESS LIST.
 *
 * ⚠ THE NAME WITH "(you)" AFTER IT, AND THE ADDRESS BENEATH — the same two lines every reader's row
 * has, so the owner reads as one more row of the list rather than a heading over it. Only when the
 * token names nobody does "You" stand in for the name, and then "(you)" is not repeated after it.
 *
 * ⚠ `Owner` WHERE A READER'S LEVEL GOES, AND NO REMOVE. The owner's access is not a grant anybody
 * made, so there is nothing to take back.
 */
function OwnerRow() {
  const language = useLanguage()
  const name = () => viewer()?.name
  const email = () => viewer()?.email
  return (
    <div class={ROW_CLASS} data-component="session-share-owner">
      <PersonCircle name={name() ?? email() ?? language.t("session.share.you")} />
      <span class="min-w-0 flex-1">
        {/* One phrase, not the name plus a "(you)" fragment: where the tag goes, and what separates it, is each language's. */}
        <span class="block truncate text-[14px] leading-5 text-v2-text-text-base">
          <Show when={name()} fallback={language.t("session.share.you")}>
            {(value) => language.t("session.share.ownerName", { name: value() })}
          </Show>
        </span>
        <Show when={email()}>
          {(address) => (
            <span class="block truncate text-[11px] leading-normal text-v2-text-text-muted">{address()}</span>
          )}
        </Show>
      </span>
      <span class="shrink-0 px-1.5 text-[11px] leading-normal text-v2-text-text-muted">
        {language.t("session.share.owner")}
      </span>
    </div>
  )
}

/**
 * ONE ROW UNDER "PEOPLE WITH ACCESS" — a person, or the whole course, with the control that takes the
 * grant back.
 *
 * ⚠ THE CLASS ROW IS SHAPED LIKE A PERSON'S, because it is withdrawn the same way; a grant you take
 * back with a different gesture is one people hesitate over. Its circle is a group glyph rather than
 * initials, so it does not read as one more classmate with an unusually long name.
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
    <div class={ROW_CLASS} data-component="session-share-reader">
      <Show
        when={person()}
        fallback={
          <span class="flex size-6 shrink-0 items-center justify-center rounded-full bg-v2-background-bg-layer-03 text-v2-icon-icon-muted">
            <IconV2 name="assistant-users" class="size-3" />
          </span>
        }
      >
        {(reader) => <PersonCircle name={reader().name} />}
      </Show>
      <span class="min-w-0 flex-1">
        <span class="block truncate text-[14px] leading-5 text-v2-text-text-base">{name()}</span>
        <Show when={detail()}>
          {(text) => <span class="block truncate text-[11px] leading-normal text-v2-text-text-muted">{text()}</span>}
        </Show>
      </span>
      <AccessMenu
        name={name()}
        access={props.reader.access}
        busy={props.busy}
        onRemove={() => props.onRemove(person()?.userId ?? EVERYONE)}
      />
    </div>
  )
}

/**
 * A READER'S LEVEL, AND THE WAY TO TAKE THE GRANT BACK — one control, the way a shared document puts
 * "Remove access" in the same menu as the role.
 *
 * ⚠ ONE LEVEL, DRAWN CHECKED, AND NO GREYED-OUT SECOND OPTION. Nothing may write `comment` yet, and a
 * disabled option would be a promise in a different costume.
 *
 * ⚠ DRAWN INSIDE THE PANEL, NOT AS A `MenuV2`, for the reason at the top of this file. So it closes
 * itself: on a choice, on a press anywhere outside it, on Tab, and on Escape, which it claims before
 * the popover can.
 */
function AccessMenu(props: { name: string; access: Jolli.ShareAccess; busy: boolean; onRemove: () => void }) {
  const language = useLanguage()
  const [menu, setMenu] = createStore({ open: false })
  let wrapper: HTMLDivElement | undefined
  let trigger: HTMLButtonElement | undefined
  let list: HTMLDivElement | undefined
  const level = () =>
    language.t(props.access === "comment" ? "session.share.access.comment" : "session.share.access.view")
  const label = () => language.t("session.share.accessFor", { level: level(), name: props.name })
  const items = () => Array.from(list?.querySelectorAll<HTMLElement>("[role^='menuitem']") ?? [])
  const closeToTrigger = () => {
    setMenu("open", false)
    trigger?.focus()
  }
  useInnerLayerEscape(() => menu.open, closeToTrigger)

  createEffect(() => {
    if (!menu.open) return
    // Opening lands on the checked level, the item that says what the access is now.
    items()[0]?.focus()
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && wrapper?.contains(event.target)) return
      setMenu("open", false)
    }
    document.addEventListener("pointerdown", onPointerDown)
    onCleanup(() => document.removeEventListener("pointerdown", onPointerDown))
  })

  /** Arrow keys, Home and End move between the items, wrapping at either end; Tab leaves and shuts it. */
  const onMenuKeyDown = (event: KeyboardEvent) => {
    const all = items()
    const current = all.findIndex((item) => item === document.activeElement)
    const last = all.length - 1
    const moves: Partial<Record<string, number>> = {
      ArrowDown: current >= last ? 0 : current + 1,
      ArrowUp: current <= 0 ? last : current - 1,
      Home: 0,
      End: last,
    }
    const next = moves[event.key]
    if (next !== undefined) {
      event.preventDefault()
      all[next]?.focus()
      return
    }
    if (event.key === "Tab") setMenu("open", false)
  }

  return (
    <div ref={wrapper} class="relative shrink-0">
      {/*
       * ⚠ `aria-disabled` WHILE BUSY, NOT `disabled`, AND IT ONLY REFUSES TO OPEN. Closing hands focus
       * back to this trigger (`closeToTrigger`), which a disabled button cannot take — the item that
       * held it would unmount and leave focus on `body`, outside the panel.
       */}
      <button
        ref={trigger}
        type="button"
        onClick={() => {
          if (props.busy && !menu.open) return
          setMenu("open", !menu.open)
        }}
        aria-disabled={props.busy}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        // The level leads the name: it is what the control shows, so voice control finds it by what is on screen.
        aria-label={label()}
        class="flex items-center gap-1 rounded-[6px] px-1.5 py-1 text-[11px] leading-normal text-v2-text-text-muted transition-colors hover:bg-v2-background-bg-base hover:text-v2-text-text-base aria-disabled:opacity-50"
        data-action="session-share-access"
      >
        {level()}
        <IconV2 name="chevron-down" size="small" class="size-3" />
      </button>
      <Show when={menu.open}>
        <div
          ref={list}
          role="menu"
          aria-label={label()}
          onKeyDown={onMenuKeyDown}
          class="absolute right-0 top-full z-50 mt-1 flex w-44 flex-col rounded-[8px] border border-v2-border-border-base bg-v2-background-bg-layer-01 p-1 shadow-[var(--v2-elevation-floating)]"
        >
          <button
            type="button"
            role="menuitemradio"
            aria-checked={true}
            onClick={closeToTrigger}
            class="flex items-center justify-between gap-2 rounded-[6px] px-2 py-1.5 text-left text-[14px] text-v2-text-text-base outline-none transition-colors hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover"
          >
            {level()}
            <IconV2 name="check" size="small" />
          </button>
          <div role="separator" class="my-1 h-px bg-v2-border-border-base" />
          {/*
           * The row this sits in goes away with the grant, so the focus is not sent back to a trigger about to disappear.
           *
           * ⚠ `aria-disabled` WHILE BUSY, NOT `disabled`. The menu can be open, with focus on this item,
           * when a request starts; a disabled item would drop that focus to `body`, outside the panel.
           */}
          <button
            type="button"
            role="menuitem"
            aria-disabled={props.busy}
            onClick={() => {
              if (props.busy) return
              setMenu("open", false)
              props.onRemove()
            }}
            class="rounded-[6px] px-2 py-1.5 text-left text-[14px] text-v2-text-text-base outline-none transition-colors hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover aria-disabled:opacity-50"
            data-action="session-share-remove"
          >
            {language.t("session.share.removeAccess")}
          </button>
        </div>
      </Show>
    </div>
  )
}

/**
 * THE ASSISTANT THAT ANSWERED, AS THE PANEL'S FOOTER.
 *
 * ⚠ NOT IN THE ACCESS LIST. Nobody let it in and there is nothing to take back — a row with no level
 * and no remove among rows that all have both would read as a broken one.
 *
 * ⚠ DRESSED UNLIKE A PERSON ON PURPOSE: its glyph, white, on its own accent — how the web dresses an
 * assistant. The white is inline because `text-white` does not exist here: the Tailwind theme resets
 * the palette (`--color-*: initial` in `ui/src/styles/tailwind/colors.css`), so the class emits
 * nothing and the glyph would inherit the surrounding dark text.
 */
function AssistantFooter(props: { assistant: Assistant }) {
  const language = useLanguage()
  return (
    <div
      class="flex min-w-0 items-center gap-3 border-t border-v2-border-border-base px-4 py-3"
      data-component="session-share-assistant"
    >
      <span
        class="flex size-6 shrink-0 items-center justify-center rounded-full"
        style={{ background: `var(--dataviz-cat-${props.assistant.accent})`, color: "#fff" }}
        aria-hidden="true"
      >
        <IconV2 name={assistantIconName(props.assistant.icon)} class="size-3" />
      </span>
      <span class="min-w-0 flex-1 truncate text-[12px] text-v2-text-text-muted">
        {language.t("session.share.answeredBy", { name: props.assistant.name })}
      </span>
    </div>
  )
}

/**
 * THE "?" BESIDE "PEOPLE WITH ACCESS", AND THE SENTENCES BEHIND IT — the web's `ChatSharingHelp`.
 *
 * ⚠ THE RULE ABOUT WHO MAY BE ADDED LIVES HERE, not at the foot of the picker: stated where the
 * question is asked it is read, stated under a list somebody is scrolling it is furniture.
 *
 * ⚠ IT ANSWERS TO HOVER, AND A PRESS ONLY EVER SHOWS IT — a keyboard's way in. Focus alone is not
 * enough: the card would otherwise throw itself open whenever focus passed through the panel.
 *
 * ⚠ THE CARD HANGS INSIDE THE HOVER REGION — the gap above it is the wrapper's padding, not the card's
 * margin — so the pointer moving onto it never leaves and nothing has to chase it with a timer. It is
 * anchored to the right, so it spills across the transcript rather than off the window: the panel it
 * belongs to is drawn against the header's right end.
 */
function ShareHelp(props: { code: string }) {
  const language = useLanguage()
  const [help, setHelp] = createStore({ shown: false })
  useInnerLayerEscape(
    () => help.shown,
    () => setHelp("shown", false),
  )
  return (
    <span
      class="relative flex"
      onPointerEnter={() => setHelp("shown", true)}
      onPointerLeave={() => setHelp("shown", false)}
    >
      <button
        type="button"
        aria-label={language.t("session.share.help.open")}
        aria-expanded={help.shown}
        onClick={() => setHelp("shown", true)}
        onBlur={() => setHelp("shown", false)}
        class="flex size-4 shrink-0 cursor-help items-center justify-center rounded-full border border-v2-border-border-base text-[10px] font-[530] text-v2-text-text-muted transition-colors hover:border-v2-border-border-strong hover:text-v2-text-text-base focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-v2-border-border-focus"
      >
        ?
      </button>
      <Show when={help.shown}>
        <span class="absolute right-0 top-full z-50 pt-1.5">
          <span class="flex w-72 flex-col gap-2.5 rounded-[8px] border border-v2-border-border-base bg-v2-background-bg-layer-01 p-3 text-[12px] leading-relaxed text-v2-text-text-muted shadow-[var(--v2-elevation-floating)]">
            {/* One glyph per sentence: a lock for where a session starts, a refresh for a share that keeps showing new messages, a group for who may be let in. */}
            <HelpLine icon="lock">{language.t("session.share.help.private")}</HelpLine>
            <HelpLine icon="arrows-clockwise">{language.t("session.share.help.live")}</HelpLine>
            <HelpLine icon="assistant-users">
              {language.t("session.share.help.onlyThisCourse", { code: props.code })}
            </HelpLine>
          </span>
        </span>
      </Show>
    </span>
  )
}

/** One sentence of the help card, nudged down beside its first line rather than centred on a wrapped pair. */
function HelpLine(props: { icon: string; children: string }) {
  return (
    <span class="flex gap-2">
      <IconV2 name={props.icon} class="mt-0.5 size-3.5 shrink-0" />
      <span class="min-w-0 flex-1">{props.children}</span>
    </span>
  )
}

/**
 * ONE GROUP OF THE PICKER, WITH ITS ONE-PRESS ACTION ON THE HEADING ROW.
 *
 * ⚠ THE ADDRESS IS SEARCHED BUT NEVER DRAWN. A column of classmates' email addresses is a roster of
 * the course, and the panel that shares one session is not the place to hand one out.
 *
 * ⚠ `aria-disabled` WHILE BUSY, NOT `disabled` — the search field's reason. `busy` turns on for the
 * coaching gate's background read too, and a candidate reached with Tab would drop its focus to
 * `body` the moment it did. The press is refused here instead, before the pick closes the list.
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
        <div class="flex items-center justify-between gap-2 px-2 pt-1">
          <span class="select-none text-[11px] font-[530] uppercase leading-normal tracking-wide text-v2-text-text-muted">
            {props.label}
          </span>
          <Show when={props.bulk}>
            {(bulk) => (
              <button
                type="button"
                aria-disabled={props.busy}
                onClick={() => {
                  if (props.busy) return
                  bulk().onPick()
                }}
                class="shrink-0 rounded-[6px] px-1 py-0.5 text-[11px] font-[530] leading-normal text-v2-text-text-accent transition-colors hover:bg-v2-overlay-simple-overlay-hover aria-disabled:opacity-50"
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
              aria-disabled={props.busy}
              title={language.t("session.share.picker.shareWith", { name: candidate.name })}
              onClick={() => {
                if (props.busy) return
                props.onPick(candidate.userId)
              }}
              class="flex min-w-0 items-center gap-2.5 rounded-[6px] px-2 py-1.5 text-left transition-colors hover:bg-v2-overlay-simple-overlay-hover aria-disabled:opacity-50"
              data-component="session-share-candidate"
            >
              <PersonCircle name={candidate.name} />
              <span class="min-w-0 flex-1 truncate text-[14px] text-v2-text-text-base">{candidate.name}</span>
            </button>
          )}
        </For>
        {/* The hidden count is drawn, so a capped list never reads as the whole course. */}
        <Show when={hidden() > 0}>
          <p class="px-2 pt-1 text-[11px] leading-normal text-v2-text-text-muted">
            {language.plural("session.share.picker.more", hidden())}
          </p>
        </Show>
      </div>
    </Show>
  )
}
