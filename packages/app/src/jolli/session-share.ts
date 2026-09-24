/**
 * THE SHARE PANEL'S RULES, KEPT OUT OF THE COMPONENT.
 *
 * Ported from jolliedu's `ConversationShareRows.ts`. The web panel and this one offer the same people
 * and say the same sentence for the same grants; the facts come from the sidecar's
 * `/jolli/session/:sessionID/share`, and only what is decided per keystroke — who is still offerable,
 * who matches a search — is decided here.
 */
import type { Jolli } from "@opencode-ai/schema/jolli"

/**
 * HOW MANY ROWS A PICKER GROUP DRAWS BEFORE THE REST MUST BE SEARCHED FOR.
 *
 * ⚠ A CAP ON THE RENDER, NEVER ON THE DATA. The whole roster is searched; a picker that only held
 * the first forty would answer "nobody matches that" about a classmate sitting in the course.
 */
export const RENDER_CAP = 40

/**
 * THE MEMBERS THE PICKER MAY STILL OFFER, STAFF FIRST.
 *
 * ⚠ PEOPLE WHO ALREADY HOLD A GRANT ARE DROPPED — re-sharing is a re-level, and with one writable
 * level it changes nothing. ⚠ THE CLASS GRANT TAKES NOBODY OUT: it is not a grant to any of these
 * people, and naming one of them is a grant they keep if the course-wide one is withdrawn.
 */
export function shareCandidates(members: readonly Jolli.ShareMember[], readers: readonly Jolli.SessionReader[]) {
  const taken = new Set(readers.flatMap((reader) => (reader.kind === "person" ? [reader.userId] : [])))
  return members.filter((member) => !taken.has(member.userId))
}

/**
 * THE CANDIDATES A SEARCH MATCHES, over the whole list rather than what is rendered, by name or by
 * the address a picker never draws.
 */
export function matchCandidates(candidates: readonly Jolli.ShareMember[], query: string) {
  const needle = query.trim().toLowerCase()
  if (!needle) return candidates
  return candidates.filter(
    (candidate) =>
      candidate.name.toLowerCase().includes(needle) || !!candidate.detail?.toLowerCase().includes(needle),
  )
}

/**
 * A WRITE'S ANSWER, FOLDED INTO WHAT THE PANEL ALREADY HOLDS.
 *
 * ⚠ ONLY AN `ok` REPLACES THE READERS, and it replaces them whole — the server composed them, and a
 * row spliced in here would be a second answer. The roster and class size stay the read's: writes do
 * not carry them. Anything else leaves the panel as it was and says why beside it.
 */
export function applyWrite(current: Jolli.SessionShare, write: Jolli.SessionShare): Jolli.SessionShare {
  if (write.status === "ok")
    return {
      ...current,
      status: "ok",
      courseId: write.courseId,
      courseCode: write.courseCode,
      readers: write.readers,
    }
  if (write.status === "unsynced") return { ...current, status: "unsynced" }
  return current
}

/** WHY A WRITE DID NOT LAND, OR NOTHING WHEN IT DID. An unreachable gateway is the generic sentence. */
export function writeRefusal(write: Jolli.SessionShare): Jolli.ShareRefusal | undefined {
  if (write.status === "ok" || write.status === "unsynced") return undefined
  return write.refusal ?? "unknown"
}

/**
 * WHETHER COURSE STAFF CAN READ THIS SESSION ON JOLLI — the coaching-prose privacy gate.
 *
 * ⚠ TWO WAYS IN, BOTH GRANTS: the class-wide grant, which admits whoever holds a seat, staff
 * included; or a named grant to somebody the course roster lists as staff. A reader row carries no
 * role, so the roster is what says who is staff.
 *
 * ⚠ IT FAILS CLOSED. Anything short of an `ok` answer, a roster that could not be read, or a reader
 * who has since left the roster reads as "staff cannot", which keeps the exchange away from a model
 * — the safe direction. Getting it wrong the other way would put a withheld session's words into a
 * nudge its professor reads.
 */
export function staffCanRead(share: Jolli.SessionShare | undefined) {
  if (share?.status !== "ok") return false
  const staff = new Set(share.members.flatMap((member) => (member.kind === "staff" ? [member.userId] : [])))
  return share.readers.some((reader) => reader.kind === "class" || staff.has(reader.userId))
}

/**
 * WHAT THE PICKER CAN OFFER, OR WHY IT CANNOT.
 *
 * ⚠ THREE WAYS TO HAVE NOBODY TO OFFER, AND ONLY ONE OF THEM MEANS "EVERYONE CAN ALREADY READ IT".
 * A roster the gateway would not give us and a course with nobody else in it both leave the list
 * empty too; worded as "exhausted", they told a student their private session was open to the
 * whole course.
 */
export function pickerState(share: Jolli.SessionShare, candidates: readonly Jolli.ShareMember[]) {
  if (candidates.length > 0) return "pick" as const
  if (share.roster === "unavailable") return "roster-unavailable" as const
  if (share.members.length === 0) return "nobody-else" as const
  return "exhausted" as const
}

/**
 * THE LETTERS IN A PERSON'S CIRCLE, as jolliedu's `UserAvatar` draws them: the first letter of the
 * first and last words ("Sam Li" → "SL"), or one letter for a one-word name — which is also what a
 * CJK name without spaces gets ("李雷" → "李"). Graphemes, not code units, so an emoji or an accented
 * letter is never split in half.
 */
export function initials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const first = (word: string | undefined) => (word ? (Array.from(word)[0] ?? "") : "")
  if (words.length <= 1) return first(words[0]).toUpperCase()
  return (first(words[0]) + first(words[words.length - 1])).toUpperCase()
}
