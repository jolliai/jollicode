import { isNeverAutoApproved } from "@opencode-ai/core/jolli/assignment"
import { base64Encode } from "@opencode-ai/core/util/encode"

export function acceptKey(sessionID: string, directory?: string) {
  if (!directory) return sessionID
  return `${base64Encode(directory)}/${sessionID}`
}

export function directoryAcceptKey(directory: string) {
  return `${base64Encode(directory)}/*`
}

function accepted(autoAccept: Record<string, boolean>, sessionID: string, directory?: string) {
  const key = acceptKey(sessionID, directory)
  return autoAccept[key] ?? autoAccept[sessionID]
}

export function isDirectoryAutoAccepting(autoAccept: Record<string, boolean>, directory: string) {
  const key = directoryAcceptKey(directory)
  return autoAccept[key] ?? false
}

function sessionLineage(session: { id: string; parentID?: string }[], sessionID: string) {
  const parent = session.reduce((acc, item) => {
    if (item.parentID) acc.set(item.id, item.parentID)
    return acc
  }, new Map<string, string>())
  const seen = new Set([sessionID])
  const ids = [sessionID]

  for (const id of ids) {
    const parentID = parent.get(id)
    if (!parentID || seen.has(parentID)) continue
    seen.add(parentID)
    ids.push(parentID)
  }

  return ids
}

/**
 * What a decision is about: a session, and — for a request rather than a toggle — the permission asked.
 *
 * ⚠ THE PERMISSION IS WHAT LETS A HAND-IN THROUGH UNANSWERED NOWHERE. Every auto-approval path in
 * `permission.tsx` — a request as it arrives, the pending ones a session or folder toggle sweeps up,
 * the notification and the dock that hide what will be auto-answered — asks one of the two functions
 * below, so refusing here refuses everywhere. A toggle's own state is asked without one.
 */
type Asked = { sessionID: string; permission?: string }

export function autoRespondsPermission(
  autoAccept: Record<string, boolean>,
  session: { id: string; parentID?: string }[],
  permission: Asked,
  directory?: string,
) {
  if (permission.permission !== undefined && isNeverAutoApproved(permission.permission)) return false
  const value = sessionAutoAccept(autoAccept, session, permission, directory)
  if (value !== undefined) return value
  return directory ? isDirectoryAutoAccepting(autoAccept, directory) : false
}

export function sessionAutoAccept(
  autoAccept: Record<string, boolean>,
  session: { id: string; parentID?: string }[],
  permission: Asked,
  directory?: string,
) {
  // Handing work in counts only when the student clicked; see `isNeverAutoApproved`.
  if (permission.permission !== undefined && isNeverAutoApproved(permission.permission)) return false
  return sessionLineage(session, permission.sessionID)
    .map((id) => accepted(autoAccept, id, directory))
    .find((item): item is boolean => item !== undefined)
}
