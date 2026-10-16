export * as CourseSkillHistory from "./skill-history"

import { Option, Schema } from "effect"
import { Jolli } from "@opencode-ai/schema/jolli"

type CourseSkillReference = Jolli.CourseSkillReference

const KEY = "jolliCourseSkillReferences"
const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)
const decodeReference = Schema.decodeUnknownOption(Jolli.CourseSkillReference)
const LIMIT = 50

export function parse(text: string): CourseSkillReference[] {
  if (!text.includes('"course_skill_ref"')) return []
  return Option.toArray(decodeJson(text)).flatMap((value) => Option.toArray(decodeReference(value)))
}

export function read(metadata: Record<string, unknown> | undefined): CourseSkillReference[] {
  const value = metadata?.[KEY]
  if (typeof value !== "string") return []
  const decoded = Option.getOrUndefined(decodeJson(value))
  return Array.isArray(decoded) ? decoded.flatMap((item) => Option.toArray(decodeReference(item))) : []
}

/** Compacted history retains the latest immutable invocation of each skill, never its body. */
export function merge(groups: ReadonlyArray<ReadonlyArray<CourseSkillReference>>): CourseSkillReference[] {
  const latest = new Map<number, CourseSkillReference>()
  for (const reference of groups.flat()) {
    if (!Number.isSafeInteger(reference.messageId) || reference.messageId <= 0) continue
    if (!Number.isSafeInteger(reference.skillId) || reference.skillId <= 0) continue
    latest.delete(reference.skillId)
    latest.set(reference.skillId, reference)
  }
  return [...latest.values()].slice(-LIMIT)
}

/** A scalar metadata value cannot be mistaken for provider-specific options by legacy replay. */
export function metadata(references: ReadonlyArray<CourseSkillReference>): Record<string, string> {
  return { [KEY]: JSON.stringify(merge([references])) }
}

export function remap(
  reference: CourseSkillReference,
  copies: ReadonlyArray<{ readonly sourceMessageId: number; readonly reference: CourseSkillReference }>,
): CourseSkillReference {
  const copy = copies.find(
    (copy) =>
      copy.sourceMessageId === reference.messageId &&
      copy.reference.skillId === reference.skillId &&
      copy.reference.command === reference.command &&
      copy.reference.name === reference.name &&
      copy.reference.toolCallId === reference.toolCallId,
  )
  return copy?.reference ?? reference
}
