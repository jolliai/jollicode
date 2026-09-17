/**
 * WHO CAN READ THIS SESSION, AS A CONTROL IN THE COMPOSER.
 *
 * ⚠ THE ICON CARRIES THE STATE AND THE MENU CARRIES THE DETAIL. A student glancing at the composer
 * mid-task should not have to open anything to know whether somebody is reading: the crossed-out
 * eye is the one-bit answer, its hover text is the sentence, and the menu is where it changes.
 *
 * ⚠ IT SITS IN THE COMPOSER RATHER THAN IN A SETTINGS PANE BECAUSE THAT IS WHERE THE DECISION IS
 * MADE. The question "how candid should I be" arrives while typing, not while configuring.
 *
 * ⚠ TWO CHECKBOXES, NOT A LIST OF POLICIES, AND THE FIRST VERSION HAD IT THE OTHER WAY. Staff and
 * classmates are independent grants — "my study group can see this, my professor cannot" is a real
 * and common answer — so radio rows made that state unrepresentable and, worse, made the professor's
 * own policy row ("always shared") look like something a student had chosen. Private is the state
 * where both are off rather than a third row saying so.
 */

import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { Show } from "solid-js"
import { useCourseSession } from "@/jolli/session-binding"
import { sharingSummary } from "@/jolli/sharing"

export function PromptPrivacyControl() {
  const binding = useCourseSession()

  const sharing = () => binding.current()?.sharing
  const course = () => binding.course()
  const shared = () => !!sharing()?.staff || !!sharing()?.everyone
  const summary = () => sharingSummary(sharing(), course())
  return (
    <Show
      when={sharing()}
      fallback={
        /*
         * ⚠ GREYED BEFORE A COURSE IS CHOSEN, LIKE THE MODEL CONTROL BESIDE IT. Visibility is a
         * fact about a session that does not exist yet, so there is nothing to show and nothing to
         * change — but hiding the control would shuffle the composer's buttons sideways the moment
         * a course is picked, on the screen where the reader is picking one.
         */
        <IconButtonV2
          data-action="prompt-privacy"
          type="button"
          icon={<IconV2 name="eye" />}
          variant="ghost-muted"
          size="large"
          disabled
          aria-label="Who can read this session"
        />
      }
    >
      {(value) => (
        <TooltipV2 placement="top" value={summary()}>
          <MenuV2 gutter={6} modal={false} placement="top-start">
            <MenuV2.Trigger
              as={IconButtonV2}
              data-action="prompt-privacy"
              type="button"
              icon={<IconV2 name={shared() ? "eye" : "eye-off"} />}
              variant="ghost-muted"
              size="large"
              aria-label={summary()}
            />
            <MenuV2.Portal>
              <MenuV2.Content style={{ "min-width": "248px" }}>
                {/*
                 * ⚠ THE HEADING GOES INSIDE THE GROUP, NOT ABOVE IT. Kobalte's `GroupLabel` reads a
                 * group context, so a label placed as a sibling of the items compiles fine and then
                 * throws the moment the menu opens ("must be used within a `Menu.Group`").
                 */}
                <MenuV2.Group>
                  <MenuV2.GroupLabel>Who can read this session</MenuV2.GroupLabel>
                  {/*
                   * ⚠ PRIVATE IS A ROW, NOT AN INFERENCE. It is the state where both switches below
                   * are off, and leaving it implicit meant the menu offered only ways to SHARE — a
                   * student looking for the word "private" found a product that appeared not to have
                   * one. Ticked when nobody else can read this, and one click back to it.
                   *
                   * ⚠ A CHECKBOX ROW LIKE ITS NEIGHBOURS, THOUGH IT BEHAVES LIKE A RADIO. Unchecking
                   * "private" is not a request the product can answer — private to whom instead? —
                   * so it ignores `false` and the two rows below are what turn it off. Same shape,
                   * same tick column, no third visual idiom for three lines of one question.
                   */}
                  <MenuV2.CheckboxItem
                    checked={!value().staff && !value().everyone}
                    disabled={!binding.mayMakePrivate()}
                    onChange={(next) => next && binding.setPrivate()}
                  >
                    Private to me
                  </MenuV2.CheckboxItem>
                  <MenuV2.Separator />
                  <MenuV2.CheckboxItem
                    checked={value().staff}
                    /**
                     * ⚠ SHOWN AND REFUSED UNDER A COURSE THAT REQUIRES IT, NEVER HIDDEN. A missing
                     * row would tell a student their product cannot do this; a disabled one, plus
                     * the line below, tells them their professor decided — which is true, and is
                     * the thing they would otherwise go and ask.
                     */
                    disabled={value().staff && !binding.mayMakePrivate()}
                    onChange={(next) => binding.setStaffShared(next)}
                  >
                    {course()?.code ?? "Course"} staff
                  </MenuV2.CheckboxItem>
                  {/*
                   * ⚠ A MEMBERSHIP, NOT A LINK, AND THE LABEL HAS TO SAY SO. The web mock refuses
                   * url sharing for the same reason: a transcript with a reader nobody can name is
                   * worth nothing as evidence. This shares with the course's roster, so it follows
                   * the roster and never reaches anybody outside the course.
                   */}
                  <MenuV2.CheckboxItem checked={value().everyone} onChange={(next) => binding.setEveryone(next)}>
                    Everyone in {course()?.code ?? "the course"}
                  </MenuV2.CheckboxItem>
                </MenuV2.Group>
                <Show when={!binding.mayMakePrivate()}>
                  <MenuV2.Separator />
                  {/*
                   * ⚠ NAMES WHO OWNS THE REFUSAL. "Locked" without an owner is the same dead end as
                   * hiding the row. Present tense and flat: staff reading a session a course asked
                   * them to read have not done anything to the student that needs a warning.
                   *
                   * ⚠ A PLAIN LINE RATHER THAN A `GroupLabel`, for two reasons: it labels nothing,
                   * and the group-label slot is a fixed 28px single row that would clip a sentence
                   * this long. Same faint type, allowed to wrap.
                   */}
                  <div class="select-none px-3 py-1.5 text-[11px] leading-snug text-v2-text-text-faint">
                    {course()?.code ?? "This course"} requires sessions to stay shared with staff.
                  </div>
                </Show>
              </MenuV2.Content>
            </MenuV2.Portal>
          </MenuV2>
        </TooltipV2>
      )}
    </Show>
  )
}
