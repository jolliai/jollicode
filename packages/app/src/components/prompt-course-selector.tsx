/**
 * WHICH COURSE, AND WHOSE ASSISTANT, THIS SESSION WILL BELONG TO.
 *
 * ⚠ THESE RENDER ONLY ON THE NEW-SESSION SCREEN, AND THAT ABSENCE ELSEWHERE IS THE LOCK. A session's
 * course decides which models may run and who may read the transcript; changing it halfway through
 * would retroactively re-scope work already done under different terms. Project, location and branch
 * are already fixed this way, so a student meets one rule rather than two.
 *
 * ⚠ THE VISUAL LANGUAGE IS `prompt-workspace-selector.tsx`'s, DELIBERATELY. This row sits directly
 * above that one, and two selector rows built to different measurements read as two features that
 * happen to be adjacent rather than one decision made in stages.
 */

import { For, Show } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { Lookup } from "@opencode-ai/core/jolli/lookup"
import { CourseAccent } from "@/components/course-accent"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { useLanguage } from "@/context/language"
import { assistantsForCourse, blockedReason, canStartSession, enrolledCourses } from "@/jolli/catalog"
import { useCourseSession } from "@/jolli/session-binding"

/**
 * ONE DICTIONARY KEY PER REFUSAL. `Lookup.blockedReason` answers with a code rather than a sentence
 * so that this surface can word them through the dictionary, which `packages/app/AGENTS.md` requires
 * of everything a student reads.
 *
 * ⚠ THE `satisfies` IS THE POINT OF THE MAP. A course entry state added upstream fails to compile
 * here instead of rendering a blocked row with nothing beside it to say why.
 */
const BLOCKED_REASON = {
  draft: "prompt.course.blocked.draft",
  "not-yet": "prompt.course.blocked.notYet",
  ended: "prompt.course.blocked.ended",
  archived: "prompt.course.blocked.archived",
  "no-assistants": "prompt.course.blocked.noAssistants",
} as const satisfies Record<Lookup.CourseBlockedReason, string>

const TRIGGER_CLASS =
  "flex h-7 min-w-0 max-w-[203px] items-center gap-1.5 rounded-sm px-1.5 hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none data-[expanded]:bg-v2-overlay-simple-overlay-pressed data-[expanded]:text-v2-text-text-muted"

export function PromptCourseSelector(props: { onDone?: () => void }) {
  const language = useLanguage()
  const binding = useCourseSession()
  const courses = () => enrolledCourses()
  const current = () => binding.course()

  return (
    <MenuV2 placement="bottom" gutter={4} onOpenChange={(open) => !open && props.onDone?.()}>
      <MenuV2.Trigger class={TRIGGER_CLASS}>
        {/* The chosen course's colour, or nothing to colour until one is chosen. `CourseAccent`
            says why this replaced a kind glyph. */}
        <Show when={current()} keyed>
          {(course) => <CourseAccent accent={course.accent} class="h-3.5 w-1" />}
        </Show>
        <span class="min-w-0 truncate">{current()?.code ?? language.t("prompt.course.placeholder")}</span>
        <Icon name="chevron-down" size="small" class="shrink-0 text-v2-icon-icon-muted" />
      </MenuV2.Trigger>
      <MenuV2.Portal>
        <MenuV2.Content class="w-[260px]">
          <MenuV2.Group>
            <MenuV2.GroupLabel>{language.t("prompt.course.group")}</MenuV2.GroupLabel>
            <For each={courses()}>
              {(course) => (
                <MenuV2.Item
                  /**
                   * ⚠ A COURSE THAT CANNOT BE STARTED IS SHOWN AND REFUSED, NOT HIDDEN, AND THE ROW
                   * SAYS WHY. This used to cover one case — published, but no assistant configured.
                   * It now covers four more, because the gateway sends every course a student is in
                   * rather than only the runnable ones. A list that omitted them could not say "your
                   * course opens next week"; an empty list says nothing at all, and a student whose
                   * only course is still a draft would be staring at it.
                   *
                   * ⚠ EACH REASON GETS ITS OWN SENTENCE. They lead to different next actions — wait
                   * for the teacher, wait for term, ask the teacher, nothing — so collapsing them
                   * into one "unavailable" would throw away the only useful part.
                   */
                  disabled={!canStartSession(course.id)}
                  onSelect={() => binding.draft.setCourse(course.id)}
                >
                  <CourseAccent accent={course.accent} />
                  <span class="min-w-0 flex-1 truncate">
                    {course.code}
                    <span class="text-v2-text-text-faint"> · {course.title}</span>
                    <Show when={blockedReason(course)}>
                      {(reason) => (
                        <span class="text-v2-text-text-faint"> · {language.t(BLOCKED_REASON[reason()])}</span>
                      )}
                    </Show>
                  </span>
                  <Show when={current()?.id === course.id}>
                    <Icon name="check" size="small" class="shrink-0" />
                  </Show>
                </MenuV2.Item>
              )}
            </For>
          </MenuV2.Group>
        </MenuV2.Content>
      </MenuV2.Portal>
    </MenuV2>
  )
}

export function PromptAssistantSelector(props: { onDone?: () => void }) {
  const language = useLanguage()
  const binding = useCourseSession()
  const options = () => assistantsForCourse(binding.course()?.id)
  const current = () => binding.assistant()

  return (
    <Show when={binding.course()}>
      <span class="hidden select-none opacity-50 sm:inline mx-1">/</span>
      <MenuV2 placement="bottom" gutter={4} onOpenChange={(open) => !open && props.onDone?.()}>
        <MenuV2.Trigger class={TRIGGER_CLASS}>
          <span class="min-w-0 truncate">{current()?.name ?? language.t("prompt.assistant.placeholder")}</span>
          <Icon name="chevron-down" size="small" class="shrink-0 text-v2-icon-icon-muted" />
        </MenuV2.Trigger>
        <MenuV2.Portal>
          <MenuV2.Content class="w-[300px]">
            <MenuV2.Group>
              <MenuV2.GroupLabel>{language.t("prompt.assistant.group")}</MenuV2.GroupLabel>
              <For
                each={options()}
                fallback={
                  /* The published-but-unconfigured branch. Says whose job the absence is, so a
                     student does not read it as something they have configured wrong. Reachable in
                     the fixtures by publishing `cs-101`, which has no assistants. */
                  <MenuV2.Item disabled>
                    <span class="min-w-0 flex-1 truncate">
                      {language.t("prompt.assistant.empty", { code: binding.course()?.code ?? "" })}
                    </span>
                  </MenuV2.Item>
                }
              >
                {(assistant) => (
                  /**
                   * ⚠ ONE LINE PER ASSISTANT, AND THE FIRST VERSION USED TWO. The professor's blurb
                   * went under the name as a second line, which looked broken: `menu-v2-item` is
                   * `height: 28px` with centred row content, so both lines were crammed into a
                   * 28px box with no padding and the blurb clipped. Nothing in the V2 language has
                   * a two-line menu row — the model picker, the workspace picker and the server
                   * menu are all single-line — so this stops fighting the geometry.
                   *
                   * ⚠ THE BLURB SURVIVES AS HOVER TEXT, which is where this app already puts a
                   * row's detail: `dialog-select-model.tsx` hangs a whole tooltip card off each
                   * model row for exactly this reason. A student choosing between "pairing in the
                   * editor" and "reads a diff the way the marker will" still gets the sentence.
                   */
                  <MenuV2.Item onSelect={() => binding.draft.setAssistant(assistant.id)} title={assistant.blurb}>
                    <span class="min-w-0 flex-1 truncate">{assistant.name}</span>
                    <Show when={current()?.id === assistant.id}>
                      <Icon name="check" size="small" class="shrink-0" />
                    </Show>
                  </MenuV2.Item>
                )}
              </For>
            </MenuV2.Group>
          </MenuV2.Content>
        </MenuV2.Portal>
      </MenuV2>
    </Show>
  )
}
