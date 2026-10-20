/**
 * COURSE AND ASSISTANT IDS THAT NAME THEIR ORGANIZATION, SO TWO ORGANIZATIONS CAN NEVER BE CONFUSED.
 *
 * ⚠ EVERY ORGANIZATION HAS ITS OWN DATABASE SCHEMA AND ITS IDS START AT 1. Course 7 in one school
 * and course 7 in another are different courses, and that collision is the normal case rather than
 * an edge. A bare id therefore only means something next to an organization, so the client carries
 * the pair as one string, `${tenantSlug}:${orgSlug}:${id}`, and a bare numeric id stands for "no
 * organization" (a single-org sign-in, where the server infers the scope).
 *
 * ⚠ A VALUE THAT DOES NOT PARSE IS `undefined`, NOT A GUESS. Reading half of an id would address
 * the right number in the wrong organization, which is a silent mismatch; refusing it fails loudly
 * at the call site instead.
 *
 * ⚠ THE STRING IS ONLY SPLIT AT OUTBOUND BOUNDARIES. Everything inside the client passes it around
 * whole; where a request leaves for the server, the organization becomes the scope headers and the
 * id becomes the numeric id the server knows.
 */
import { courseBindingOf, isGatewayId, type CourseBinding, type SessionLike } from "./binding"

export type OrgScope = { readonly tenantSlug: string; readonly orgSlug: string }

const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

export function orgScopedId(org: OrgScope | undefined, id: number | string): string {
  if (!org) return String(id)
  return `${org.tenantSlug}:${org.orgSlug}:${id}`
}

export function parseOrgScopedId(value: string): { readonly org?: OrgScope; readonly id: number } | undefined {
  const parts = value.split(":")
  if (parts.length === 1) return isGatewayId(value) ? { id: Number(value) } : undefined
  if (parts.length !== 3) return undefined
  const [tenantSlug, orgSlug, id] = parts
  if (!SLUG.test(tenantSlug) || !SLUG.test(orgSlug) || !isGatewayId(id)) return undefined
  return { org: { tenantSlug, orgSlug }, id: Number(id) }
}

/**
 * A course binding as the numbers the gateway knows and the org they live in, or undefined when it
 * names no course this client could ask about.
 *
 * ⚠ BOTH HALVES OR NEITHER. An assistant is asked for in its course's org, so a pair whose halves
 * name two orgs — or whose one half does not parse — is no pair the gateway holds. Taking the org
 * from either half alone would address the other half's number in the wrong org. Every reader of a
 * binding's ids goes through here, so "what counts as bound" has one answer.
 */
export function parseCourseBinding(
  binding: CourseBinding | undefined,
): { readonly org?: OrgScope; readonly courseId: number; readonly assistantId: number } | undefined {
  if (!binding) return undefined
  const course = parseOrgScopedId(binding.courseId)
  const assistant = parseOrgScopedId(binding.assistantId)
  if (!course || !assistant || !sameOrg(course.org, assistant.org)) return undefined
  return { org: course.org, courseId: course.id, assistantId: assistant.id }
}

/**
 * The org a session's course binding names: where its conversation and everything asked about it
 * live. None for an unbound session, a bare binding, or one that does not parse — such a session is
 * asked about without a scope, as it was before ids named their org.
 */
export function bindingOrg(session: SessionLike | undefined): OrgScope | undefined {
  return parseCourseBinding(courseBindingOf(session))?.org
}

/** Whether two ids name the same org, no org at all counting as one. */
export function sameOrg(left: OrgScope | undefined, right: OrgScope | undefined) {
  return left?.tenantSlug === right?.tenantSlug && left?.orgSlug === right?.orgSlug
}

export function orgScopeHeaders(org: OrgScope | undefined): Record<string, string> {
  if (!org) return {}
  return { "x-jolli-org-scope": "1", "x-tenant-slug": org.tenantSlug, "x-org-slug": org.orgSlug }
}
