/**
 * THE TWO JOBS THE TITLEBAR'S TAB STRIP WAS DOING BESIDES DRAWING TABS.
 *
 * ⚠ THIS EXISTS BECAUSE DELETING THE STRIP WOULD OTHERWISE DELETE THEM SILENTLY. Both lived inside
 * the strip's render function for no better reason than that it was the component that happened to
 * have `useTabs()` and the route to hand. Neither has anything to do with drawing a tab, and neither
 * fails loudly when it stops running — one leaves you on a route that no longer exists, the other
 * degrades a keyboard shortcut. Rendering `null` from application scope is what they actually wanted.
 *
 * ⚠ THE OPEN-SESSION REGISTRY OUTLIVED THE TABS. `context/tabs.tsx` is no longer "the tab strip's
 * state" — it is where a session's unsent prompt and model choice live (`context/prompt.tsx` keys
 * `createTabMemory` by `tabKey`), where drafts live, and what `mod+w` closes. That is why it was
 * kept rather than deleted along with the strip.
 */

import { createEffect, createMemo } from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { readSessionTabsRemovedDetail, SESSION_TABS_REMOVED_EVENT } from "@/components/titlebar-session-events"
import { useCommand } from "@/context/command"
import { useHomeData } from "@/context/home-data"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useServer } from "@/context/server"
import { useTabs, type Tab } from "@/context/tabs"

export function SessionTabsSync() {
  const layout = useLayout()
  const language = useLanguage()
  const command = useCommand()
  const server = useServer()
  const tabs = useTabs()
  const { home, sessions } = useHomeData()

  /** The registry entry for whatever the route is currently showing, if it has one. */
  const currentTab = createMemo(() => {
    const route = layout.route()
    const match = (tab: Tab) => {
      if (route.type === "session") {
        return (
          tab.type === "session" && tab.server === (route.server ?? server.key) && tab.sessionId === route.sessionId
        )
      }
      if (route.type === "draft") return tab.type === "draft" && tab.draftID === route.draftID
      return false
    }
    return tabs.store.find(match)
  })

  /**
   * THE THREE COMMANDS THAT OUTLIVED THE TAB STRIP.
   *
   * ⚠ THEY KEEP THEIR IDS AND KEYBINDS, AND MEAN SESSIONS NOW RATHER THAN TABS. `mod+t` starts a
   * session, `mod+w` closes the one on screen, `mod+shift+t` reopens the last closed one — all
   * three were already doing that, described in the vocabulary of a strip that no longer exists.
   * Renaming the ids would silently discard any custom keybind a student has already set, since
   * `settings.keybinds` is keyed by id.
   *
   * ⚠ `tab.prev` / `tab.next` AND `mod+1`..`mod+9` ARE DELIBERATELY NOT HERE. They addressed a
   * tab's left-to-right position in a strip; there is no such ordering to address any more.
   * Re-adding them over the sidebar's list order is a different feature, not a port.
   *
   * ⚠ `tab.new` NO LONGER GUESSES A DIRECTORY. The old handler tried the active session, then the
   * active draft, then the home selection, then the first project on this server, then the first
   * project on any server — because tab state was all it had. The sidebar's focused project is a
   * direct answer, and `canCreate()` is honest when there is none.
   */
  command.register("session-registry", () => {
    const current = currentTab()
    return [
      {
        id: "tab.new",
        category: "tab",
        title: language.t("command.session.new"),
        keybind: "mod+t,mod+n",
        hidden: true,
        disabled: !sessions.session.canCreate(),
        onSelect: () => home.project.openNewSession(),
      },
      current && {
        id: "tab.close",
        category: "tab",
        title: language.t("command.tab.close"),
        keybind: "mod+w",
        hidden: true,
        onSelect: () => tabs.closeTab(tabs.store.findIndex((tab) => tab === current)),
      },
      {
        id: "tab.reopenClosed",
        category: language.t("command.category.file"),
        title: language.t("command.tab.reopenClosed"),
        keybind: "mod+shift+t",
        onSelect: () => tabs.reopenClosedTab(),
      },
    ].filter((value) => value !== undefined)
  })

  /**
   * KEEP `recentKey` POINTING AT WHAT YOU ARE ACTUALLY LOOKING AT.
   *
   * ⚠ IT FEEDS `nextTabAfterClose`, WHICH IS WHAT MAKES `mod+w` LAND SOMEWHERE SENSIBLE. Without
   * this, closing the session you are viewing loses its anchor and navigation falls back to `/`
   * more often than it should — a small, quiet degradation that no test would catch.
   *
   * ⚠ THE OLD VERSION ALSO REGISTERED A MISSING TAB HERE, AND THAT PART IS DELIBERATELY GONE.
   * `ResolvedTargetSessionRoute` already calls `addSessionTab` with the lineage's `root.id`
   * (`pages/session.tsx`), which is both redundant with and strictly better than what this did:
   * the old code fetched the session over the API just to discover a `parentID` the lineage
   * already knows.
   */
  createEffect(() => {
    if (!tabs.ready()) return
    const tab = currentTab()
    if (tab) tabs.remember(tab)
  })

  /**
   * ⚠ THIS IS THE ONLY LISTENER FOR THIS EVENT, AND THERE ARE THREE DISPATCHERS —
   * `pages/home-session-archive.ts`, `pages/session/session-archive.ts` and
   * `pages/session/timeline/message-timeline.tsx`. `removeSessions` does two things: it drops the
   * archived sessions from the registry, and because that may remove the entry you are standing on,
   * it navigates away. Lose the listener and archiving the session you are reading leaves you on a
   * dead route with no way to tell that is what happened.
   */
  makeEventListener(window, SESSION_TABS_REMOVED_EVENT, (event) => {
    const detail = readSessionTabsRemovedDetail(event)
    if (!detail) return
    tabs.removeSessions(detail)
  })

  return null
}
