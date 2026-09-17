/**
 * WHOSE SLASH COMMAND IS WHOSE: the assistant's own procedures first, everything else below.
 *
 * ⚠ ON THIS SURFACE A SLASH COMMAND IS NOT A TOOL THE STUDENT FOUND, it is the professor's
 * procedure, handed over by the assistant they chose. Upstream builds one flat list ordered
 * [custom, builtin] (`prompt-input-v2.tsx`), which buries the handful that are the point of the
 * course under everything that shipped with the editor.
 *
 * ⚠ THE OWNERSHIP TEST IS `skillId`, NOT THE SERVER'S `source: "skill"`. The server marks EVERY
 * skill that way — its own `customize-opencode`, and whatever a repository happens to ship in
 * `.opencode/skill` — so grouping on it would file those under the professor's name. The
 * assistant's own `skills` list is the only thing that knows which ones belong to the course.
 *
 * The join works because `writeCourseSkills` (`packages/desktop/src/main/jolli-gateway.ts`) writes
 * `skillId` into each skill's frontmatter `name`, and the v1 server takes both the skill's name and
 * the slash command it becomes from that field. That chain is the reason `skillId` is a slug and
 * the human title lives in `description` — a title with a space in it would produce a command
 * nobody can type.
 *
 * ⚠ AND ONLY A `custom` COMMAND CAN BE OWNED. Builtins come from the command palette, never from a
 * skill; testing them too would let a palette entry that happened to share a slug be captured by a
 * course it has nothing to do with.
 */

/** The header everything that is not the assistant's own sits under. */
export const OTHER_SLASH_GROUP = "Other commands"

export type SlashCommandRow = {
  trigger: string
  type: "custom" | "builtin"
}

export type AssistantSkillOwner = {
  name: string
  skills: readonly { skillId: string }[]
}

/**
 * Order `items` so the assistant's own procedures lead, and label each row with the header it sits
 * under. The result stays FLAT — the popover draws a header wherever `group` changes between one
 * row and the next, so the keyboard machine keeps walking a single array.
 *
 * ⚠ IT GROUPS ONLY WHEN THERE IS SOMETHING TO GROUP. With no course procedures present, every row
 * would land under a lone "Other commands" header that labels nothing and costs a row of a list
 * that is already scrolling — so in that case every `group` comes back undefined and the list
 * renders exactly as upstream's did.
 */
export function groupSlashCommands<T extends SlashCommandRow>(
  items: readonly T[],
  assistant: AssistantSkillOwner | undefined,
): Array<T & { group?: string }> {
  const owned = new Set((assistant?.skills ?? []).map((skill) => skill.skillId))
  const isOwned = (item: T) => item.type === "custom" && owned.has(item.trigger)

  const mine = items.filter(isOwned)
  if (mine.length === 0 || !assistant) return items.map((item) => ({ ...item, group: undefined }))

  return [
    ...mine.map((item) => ({ ...item, group: assistant.name })),
    ...items.filter((item) => !isOwned(item)).map((item) => ({ ...item, group: OTHER_SLASH_GROUP })),
  ]
}
