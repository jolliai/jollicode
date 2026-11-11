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
 * person confirms. Covers Windows, macOS and Linux launchers, installers, packages and disk images,
 * scripts the OS runs on a double click, shortcuts that open another location, libraries and
 * certificates, help and web archives, macro-enabled Office documents, and pages or images that carry
 * script.
 *
 * ⚠ THE NAME IS JUDGED AS IT WILL BE SAVED, NOT ONLY AS IT WAS SENT. Saving strips trailing dots and
 * spaces and replaces reserved characters ({@link safeChatFilename}), so "setup.exe." is checked as the
 * "setup.exe" it becomes on disk.
 *
 * Legacy Word, Excel and PowerPoint documents (`.doc`, `.xls`, `.ppt`) are left out on purpose: they are
 * what students share most, a prompt on every one would teach people to click through it, and Office's
 * default macro setting already asks before a document's macros run. Their templates, add-ins and
 * show files are rarely shared for any other reason, so those are covered.
 */
export function executableChatFile(name: string, mime: string) {
  const extension =
    /\.(?:exe|com|scr|saver|pif|cpl|msc|msi|msix|msixbundle|msu|appx|appxbundle|appref-ms|appinstaller|diagcab|ppkg|cab|xll|dll|ocx|msp|mst|gadget|application|xbap|jnlp|bat|cmd|ps1|psm1|psd1|psc1|psc2|ps1xml|ps2|ps2xml|msh|msh1|msh2|mshxml|msh1xml|msh2xml|vb|vbs|vbe|bas|js|jse|mjs|cjs|wsf|wsh|wsc|ws|wsb|sct|shb|shs|scf|xnk|website|theme|cer|crt|der|hta|chm|hlp|mht|mhtml|lnk|url|reg|inf|library-ms|search-ms|settingcontent-ms|mdb|mde|mda|accde|adp|ade|jar|sh|bash|zsh|csh|ksh|fish|command|tool|terminal|action|prefpane|desktop|app|dmg|pkg|mpkg|workflow|scpt|applescript|webloc|inetloc|fileloc|iso|img|vhdx?|appimage|snap|flatpak|flatpakref|deb|rpm|run|apk|vsix|xpi|py|pyw|pyz|pyzw|pyc|pyo|rb|pl|php|docm|dot|dotm|xlsm|xlsb|xlt|xltm|xla|xlam|pptm|pot|potm|ppa|ppam|pps|ppsm|sldm|one|onepkg|html?|xht|xhtml|shtml|svgz?)$/i
  return (
    extension.test(name) ||
    extension.test(safeChatFilename(name)) ||
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
