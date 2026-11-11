import type { GroupChatTab, SessionTab, Tab } from "./tabs"

export type ClosedTab<T extends SessionTab | GroupChatTab = SessionTab> = {
  tab: T
  index: number
}

const CLOSED_TAB_LIMIT = 25

// Session and group chat tabs are recorded; closing a draft tab deletes its
// persisted state, so a reopened draft would come back empty anyway.
export function pushClosedTab<T extends SessionTab | GroupChatTab>(
  stack: ClosedTab<T>[],
  tab: T | Extract<Tab, { type: "draft" }>,
  index: number,
): ClosedTab<T>[] {
  if (tab.type === "draft") return stack
  return [...stack, { tab: { ...tab }, index }].slice(-CLOSED_TAB_LIMIT)
}

// Pops the most recently closed tab that is not open again,
// discarding stale entries along the way.
export function takeClosedTab<T extends SessionTab | GroupChatTab>(
  stack: ClosedTab<T>[],
  tabs: Tab[],
): { entry?: ClosedTab<T>; stack: ClosedTab<T>[] } {
  const remaining = [...stack]
  while (remaining.length) {
    const entry = remaining.pop()
    if (entry && !isOpen(tabs, entry.tab)) return { entry, stack: remaining }
  }
  return { stack: remaining }
}

export function removeClosedTabs<T extends SessionTab | GroupChatTab>(
  stack: ClosedTab<T>[],
  server: SessionTab["server"],
  sessionIDs: string[],
) {
  const removed = new Set(sessionIDs)
  return stack.filter(
    (entry) => entry.tab.server !== server || entry.tab.type !== "session" || !removed.has(entry.tab.sessionId),
  )
}

// A closed group chat keeps its tab memory (the unsent draft) while an entry can
// still reopen it. Returns the chats whose last entry left the stack and that no
// open tab shows, so the caller can release their memory.
export function releasedGroupChats(
  previous: ClosedTab<SessionTab | GroupChatTab>[],
  next: ClosedTab<SessionTab | GroupChatTab>[],
  tabs: Tab[],
) {
  return previous.flatMap((entry) =>
    entry.tab.type === "groupChat" && !next.some((item) => sameTab(item.tab, entry.tab)) && !isOpen(tabs, entry.tab)
      ? [entry.tab]
      : [],
  )
}

export function nextTabAfterClose(tabs: Tab[], index: number, active: boolean) {
  if (!active) return undefined
  return tabs[index + 1] ?? tabs[index - 1] ?? null
}

// Removes every matching tab at once. The caller runs this against the tabs as they
// are when its update applies, so repeating a removal finds nothing and moves nowhere.
// `next` follows `nextTabAfterClose`: undefined stays put, null goes home.
export function removeTabsWhere(tabs: Tab[], matches: (tab: Tab) => boolean, active: (tab: Tab) => boolean) {
  const index = tabs.findIndex((tab) => matches(tab) && active(tab))
  const kept = (tab: Tab) => !matches(tab)
  return {
    tabs: tabs.filter(kept),
    next: index === -1 ? undefined : (tabs.slice(index + 1).find(kept) ?? tabs.slice(0, index).findLast(kept) ?? null),
  }
}

function isOpen(tabs: Tab[], tab: SessionTab | GroupChatTab) {
  return tabs.some((item) => sameTab(item, tab))
}

function sameTab(item: Tab, tab: SessionTab | GroupChatTab) {
  return (
    item.server === tab.server &&
    ((item.type === "session" && tab.type === "session" && item.sessionId === tab.sessionId) ||
      (item.type === "groupChat" && tab.type === "groupChat" && item.chatId === tab.chatId))
  )
}
