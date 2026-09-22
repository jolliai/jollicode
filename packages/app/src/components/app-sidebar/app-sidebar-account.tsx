/**
 * WHO IS SIGNED IN, AND THE THINGS YOU DO TO YOUR OWN SETUP, PINNED TO THE BOTTOM OF THE SIDEBAR.
 *
 * ⚠ SETTINGS AND HELP MOVED INTO THIS MENU RATHER THAN STAYING AS TWO ROWS. They were the whole of
 * `HomeUtilityNav`, sitting under the Projects list on the home page as if they belonged to it.
 * They belong to the person, not to any list, and one row that names you with those behind it says
 * so — as well as giving back two rows of height in the column that now holds all the navigation.
 *
 * ⚠ THE IDENTITY IS DECODED FROM THE TOKEN AND IS NOT AUTHORITATIVE — see
 * `packages/core/src/jolli/identity.ts`. Nothing here may branch on it beyond which words to draw.
 */

import { Show } from "solid-js"
import { Avatar } from "@opencode-ai/ui/v2/avatar-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { useHomeData } from "@/context/home-data"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { ready, viewer } from "@/jolli/catalog"
import { showToast } from "@/utils/toast"
import { APP_SIDEBAR_ROW_LABEL, AppSidebarRow } from "./app-sidebar-row"

export function AppSidebarAccount() {
  const language = useLanguage()
  const platform = usePlatform()
  const { projects } = useHomeData()

  /**
   * WHAT THE ROW SAYS, IN FOUR STATES THAT ARE NOT THE SAME STATE.
   *
   * ⚠ THE ONE WORTH DESIGNING FOR IS "UNKNOWN", NOT "SIGNED OUT". On desktop the sign-in gate
   * covers the whole window while there is no credential, so signed-out is very nearly unobservable
   * here; what a student actually sees is the handful of frames between mount and `/jolli/course`
   * answering. So `!ready()` says "Account" — true, non-committal, and in the same register as the
   * Settings row it replaced — rather than flashing a name or a placeholder.
   *
   * ⚠ AND WITH A VIEWER BUT NO FIELDS IT STILL SAYS "Account", NOT "Unknown user". The one thing we
   * do know in that state is that they are signed in.
   */
  const label = () => viewer()?.name ?? viewer()?.email ?? language.t("sidebar.account")
  const signedOut = () => ready() && !viewer()
  const named = () => !!viewer()?.name || !!viewer()?.email
  /**
   * ⚠ ONE ACCESSOR FOR THE WORDS ON THE ROW AND THE WORDS IN ITS ACCESSIBLE NAME, BECAUSE THEY WERE
   * ALLOWED TO DISAGREE. The `aria-label` was `label()` while the span rendered
   * `sidebar.account.signedOut`, so a signed-out row read "Not signed in" on screen and announced
   * "Account" — a control whose name does not contain its visible text, which is the one thing
   * voice control cannot work around.
   *
   * ⚠ AND THE LABEL IS STILL NEEDED RATHER THAN LETTING THE CONTENT SPEAK: the row's leading slot
   * holds an avatar whose fallback is an initial, which would otherwise be read as part of the name.
   */
  const rowLabel = () => (signedOut() ? language.t("sidebar.account.signedOut") : label())

  return (
    /**
     * ⚠ FIXED HEIGHT AND ALWAYS RENDERED, NEVER `Show when={viewer()}`. This is the last flex child
     * of the column; a row that appears once the answer lands would shove everything above it by
     * its own height on every launch, which is a visible jump for something that is not news.
     *
     * ⚠ THE BOTTOM PADDING TAKES THE SAFE-AREA INSET, so the row does not sit under a home
     * indicator on a platform that has one. Zero on desktop.
     */
    <div
      data-component="app-sidebar-account"
      class="shrink-0 border-t border-v2-border-border-muted px-1 pt-1"
      style={{ "padding-bottom": "max(4px, env(safe-area-inset-bottom, 0px))" }}
    >
      <MenuV2 gutter={6} placement="top-start">
        {/*
         * ⚠ `as={AppSidebarRow}` SO THIS IS BYTE-FOR-BYTE THE OTHER ROWS. Kobalte's polymorphic `as`
         * with a component is already used this way in `wsl/settings.tsx` and
         * `dialog-select-model.tsx`; hand-copying the row's hover, focus and selected styling is how
         * the bottom of the column stops matching the rest of it.
         */}
        <MenuV2.Trigger as={AppSidebarRow} type="button" data-action="sidebar-account" aria-label={rowLabel()}>
          <Show when={named()} fallback={<IconV2 name="user" size="small" class="shrink-0 text-v2-icon-icon-muted" />}>
            {/*
             * ⚠ `fallback` ONLY — NO `src`, EVER. `Avatar` will happily load an image, and the only
             * candidate source would be a `picture` claim out of a payload whose signature we never
             * verified; rendering it would make the renderer fetch an attacker-choosable origin.
             * The initial is grapheme-safe, so an emoji or a CJK first character is not split.
             */}
            <Avatar kind="user" size="small" fallback={label()} />
          </Show>
          <span class={APP_SIDEBAR_ROW_LABEL}>{rowLabel()}</span>
          <IconV2 name="outline-dots" size="small" class="shrink-0 text-v2-icon-icon-muted" />
        </MenuV2.Trigger>
        <MenuV2.Portal>
          <MenuV2.Content class="min-w-[220px]">
            {/*
             * ⚠ THE TWO LINES GO IN A `GroupLabel`, NOT AN `Item`. `menu-v2-item` is a 28px
             * single-line box with centred content — the two-line clipping trap is documented at
             * `prompt-course-selector.tsx` — and this is not something you click anyway.
             */}
            <Show when={named()}>
              <MenuV2.Group>
                <MenuV2.GroupLabel>
                  <span class="flex min-w-0 flex-col">
                    <Show when={viewer()?.name}>
                      {(name) => <span class="truncate text-v2-text-text-base">{name()}</span>}
                    </Show>
                    <Show when={viewer()?.email}>{(email) => <span class="truncate">{email()}</span>}</Show>
                  </span>
                </MenuV2.GroupLabel>
              </MenuV2.Group>
              <MenuV2.Separator />
            </Show>
            <MenuV2.Item onSelect={projects.utility.settings}>{language.t("sidebar.settings")}</MenuV2.Item>
            <MenuV2.Item onSelect={projects.utility.help}>{language.t("sidebar.help")}</MenuV2.Item>
            {/*
             * ⚠ ONE ITEM, AND ONLY WHERE SIGNING OUT MEANS SOMETHING. "Sign out" and "use a
             * different account" are now the same act — the credential is forgotten and the gate
             * comes back up — so two items doing one thing would be worse than one honest label.
             * The question "which account" belongs on the gate, which is where it is asked.
             *
             * ⚠ AND THE REJECTION IS SURFACED. `jolliSignOut` restarts the sidecar and can fail;
             * swallowing that would leave a menu item that silently does nothing.
             */}
            <Show when={platform.jolliSignOut}>
              {(signOut) => (
                <>
                  <MenuV2.Separator />
                  <MenuV2.Item
                    data-action="sidebar-account-sign-out"
                    onSelect={() => {
                      void signOut()().catch(() => showToast({ title: language.t("sidebar.account.signOut.failed") }))
                    }}
                  >
                    {language.t("sidebar.account.signOut")}
                  </MenuV2.Item>
                </>
              )}
            </Show>
          </MenuV2.Content>
        </MenuV2.Portal>
      </MenuV2>
    </div>
  )
}
