/**
 * THE ASSISTANT GLYPH'S NAME, AS THE ICON SET SPELLS IT.
 *
 * ⚠ TWO SPELLINGS OF ONE SET, AND THIS IS THE SEAM. jolliedu names these in PascalCase because they
 * are lucide component names there (`CourseAssistantIcon` in `jolli-common`); every entry in
 * `@opencode-ai/ui/v2/icon` is kebab-case. The wire carries jolliedu's spelling, so something has
 * to translate, and doing it here keeps the schema honest about what the gateway actually sends.
 *
 * ⚠ IT IS A DERIVATION, NOT A TABLE, BECAUSE A TABLE ROTS. Sixteen hand-written pairs is sixteen
 * chances to mistype one, and a seventeenth name added upstream would silently render nothing. The
 * icon registry is keyed by exactly this transform of the same names — see the block in
 * `icon.tsx` — so a name that survives `Jolli.AssistantIcon` resolves by construction.
 *
 * ⚠ AND THE PREFIX IS NOT DECORATION. `Terminal` is one of the sixteen and the registry already had
 * a `terminal` of its own, drawn 16x16 in the app's own weight — the assistant set is lucide's 24x24
 * and a different line. Namespacing keeps that collision from silently resolving to whichever entry
 * was written last, and keeps the next one from happening: `Clock`, `Users` and `Scale` are all
 * names a general icon set would reach for.
 */
import type { Jolli } from "@opencode-ai/schema/jolli"

export function assistantIconName(icon: Jolli.AssistantIcon): string {
  return `assistant-${icon.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()}`
}
