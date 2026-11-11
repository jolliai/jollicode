import type { Jolli } from "@opencode-ai/schema/jolli"

/** Replace whole aliases in one pass so replacement names cannot be matched again. */
export function replaceAliases(
  text: string,
  aliases: readonly { alias: string; userId: number }[],
  names: ReadonlyMap<number, string>,
) {
  const replacements = new Map(
    aliases.flatMap((entry) => {
      const name = names.get(entry.userId)?.trim()
      return entry.alias && name ? [[entry.alias, name] as const] : []
    }),
  )
  if (!replacements.size) return text
  const pattern = [...replacements.keys()]
    .sort((a, b) => b.length - a.length)
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")
  return text.replace(
    new RegExp(`(?<![\\p{L}\\p{N}_])(?:${pattern})(?![\\p{L}\\p{N}_])`, "gu"),
    (alias) => replacements.get(alias) ?? alias,
  )
}

export function isAttemptChat(info: Jolli.GroupChatInfo) {
  return info.assignmentGroupId !== undefined
}

export function memberActions(chat: Jolli.GroupChat, viewerId: number) {
  const viewer = chat.group.participants.find((person) => person.userId === viewerId)
  const writable = chat.access !== "reader" && viewer !== undefined && !isAttemptChat(chat.group)
  return {
    rename: writable,
    add: writable,
    leave: writable,
    remove: (userId: number) =>
      writable &&
      userId !== viewerId &&
      chat.group.participants.some((person) => person.userId === userId) &&
      (viewer.role === "staff" || viewerId === chat.group.ownerId),
  }
}

export function composerTargetFallback(target: number | null | undefined, mentionable: readonly { id: number }[]) {
  return target !== null && target !== undefined && mentionable.some((agent) => agent.id === target) ? target : null
}

/**
 * A peer's filename that is safe to create on any desktop system: no path separators or characters
 * Windows refuses, no control or direction-override characters, no leading dot, no trailing dot or
 * space (Windows drops them, which can change the extension), no reserved device name, and at most
 * 160 code points with the extension kept. The result is always well formed for encodeURIComponent.
 */
export function safeChatFilename(name: string) {
  const cleaned = name
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "_")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "_")
    .replace(/^[.\s]+/, "")
  const characters = Array.from(cleaned)
  const extension = /\.[^.\s]{1,16}$/.exec(cleaned)?.[0] ?? ""
  const bounded =
    characters.length <= 160
      ? cleaned
      : Array.from(cleaned.slice(0, cleaned.length - extension.length))
          .slice(0, 160 - Array.from(extension).length)
          .join("") + extension
  const trimmed = bounded.replace(/[.\s]+$/, "")
  if (!trimmed) return "attachment"
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(trimmed) ? `_${trimmed}` : trimmed
}
/**
 * Whether a peer's file can run or open active content once saved, so it is downloaded only after the
 * person confirms. Covers Windows, macOS and Linux launchers and installers, scripts the OS runs on a
 * double click, and pages or images that carry script.
 */
export function executableChatFile(name: string, mime: string) {
  return (
    /\.(?:exe|com|scr|pif|cpl|msc|msi|msix|msixbundle|appx|appxbundle|bat|cmd|ps1|psm1|vbs|vbe|js|jse|mjs|cjs|wsf|wsh|hta|lnk|url|reg|inf|jar|sh|bash|zsh|command|tool|terminal|app|dmg|pkg|workflow|scpt|applescript|appimage|deb|rpm|run|apk|py|rb|pl|php|html?|xhtml|svg)$/i.test(
      name,
    ) ||
    /(?:executable|shellscript|javascript|x-python|x-sh|x-msdownload|x-msdos-program|x-ms-installer|java-archive|x-apple-diskimage|android\.package-archive|application\/hta|text\/html|xhtml|image\/svg)/i.test(
      mime,
    )
  )
}

/** The same readability rule used by the course material picker and server admission. */
export function groupMaterialReadable(facts: {
  textState?: string | null
  textSource?: string | null
  textReplaced?: boolean
}) {
  return (
    facts.textState === "ready" ||
    facts.textSource === "engine" ||
    facts.textSource === "vision" ||
    facts.textSource === "reading_copy" ||
    facts.textReplaced === true
  )
}
