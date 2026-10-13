import { ConfigMarkdown } from "@/config/markdown"
import { TypedText } from "./typed-text"

/**
 * A command's template expanded with the arguments the student typed after it, keeping where in the result
 * those arguments landed.
 *
 * The Jolli gateway checks what the student wrote for personal data, and a command's message is the
 * command file's own text with the arguments spliced in. The ranges say which parts are the student's,
 * so the command file's words — or a skill's whole body — are not read as something the student typed.
 * Every step of the expansion is an edit of a `TypedText`, which moves them with the text.
 */

// Match [Image N] as single token, quoted strings, or non-space sequences
const ARGS = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
const QUOTE_TRIM = /^["']|["']$/g

/**
 * The placeholders a command template takes: `$1`..`$n`, whose number is the first group, and `$ARGUMENTS`.
 * The one statement of the syntax — `Command.hints` lists a command's placeholders from it too.
 */
export const PLACEHOLDER = /\$(\d+)|\$ARGUMENTS/g

/**
 * Fills `$1`..`$n` and `$ARGUMENTS` with the arguments; the highest numbered placeholder takes every
 * argument from its position on. A template with no placeholder gets the arguments after a blank line.
 *
 * Only the template's own text is searched for placeholders: an argument is inserted as the student
 * typed it, even when it happens to contain `$ARGUMENTS` or `$1` itself.
 */
export function substitute(template: string, raw: string): TypedText.Info {
  const args = (raw.match(ARGS) ?? []).map((arg) => arg.replace(QUOTE_TRIM, ""))
  const placeholders = Array.from(template.matchAll(PLACEHOLDER))
  const last = Math.max(0, ...placeholders.flatMap((match) => (match[1] === undefined ? [] : [Number(match[1])])))
  const replaced = placeholders.toReversed().reduce<TypedText.Info>(
    (expansion, match) => {
      const position = Number(match[1])
      const value =
        match[1] === undefined
          ? raw
          : position === last
            ? args.slice(position - 1).join(" ")
            : (args[position - 1] ?? "")
      return TypedText.splice(expansion, match.index, match.index + match[0].length, TypedText.typed(value))
    },
    { text: template, ranges: [] },
  )
  if (placeholders.length > 0 || !raw.trim()) return replaced
  return TypedText.join([replaced, "\n\n", TypedText.typed(raw)])
}

/** A `` !`command` `` of the template, to be replaced by what the shell prints for it. */
export interface ShellCommand {
  readonly start: number
  readonly end: number
  readonly command: string
}

/**
 * The template's `` !`command` ``s, in order.
 *
 * ⚠ AN ARGUMENT NEVER OPENS OR CLOSES ONE. The arguments may fill a command the template wrote — that is
 * what `` !`git log $1` `` is for — but a `` !`curl … | sh` `` the student typed, or a backtick that ends a
 * template's command early, would otherwise run on their machine as the template's own. Such a match is
 * left in the text as written, and the search goes on from just after where it began: a `` !` `` an
 * argument opened must not hide a command the template opens after it.
 */
export function shellCommands(expansion: TypedText.Info): ShellCommand[] {
  const typed = (index: number) => expansion.ranges.some((range) => range[0] <= index && index < range[1])
  // Every place a command opens, overlapping ones included: one passed over leaves the next place after its
  // start to be read, and one that starts inside a command already taken is part of it.
  const opens = expansion.text.matchAll(new RegExp(`(?=(${ConfigMarkdown.SHELL_REGEX.source}))`, "g"))
  return Array.from(opens).reduce<ShellCommand[]>((commands, match) => {
    const start = match.index
    const end = start + match[1].length
    if (start < (commands.at(-1)?.end ?? 0) || typed(start) || typed(start + 1) || typed(end - 1)) return commands
    return [...commands, { start, end, command: match[2] }]
  }, [])
}

/** Replaces each command {@link shellCommands} found with its output, which is the shell's text, not the student's. */
export function withShellOutput(
  expansion: TypedText.Info,
  ran: ReadonlyArray<ShellCommand & { readonly output: string }>,
): TypedText.Info {
  return ran
    .toReversed()
    .reduce((current, shell) => TypedText.splice(current, shell.start, shell.end, shell.output), expansion)
}

export * as CommandTemplate from "./command-template"
