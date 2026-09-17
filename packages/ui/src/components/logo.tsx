/**
 * THE THREE LEGACY LOGO SLOTS, RE-SKINNED ONTO THE JOLLI BRAND.
 *
 * ⚠ THE NAMES AND PROP SHAPES ARE UPSTREAM'S ON PURPOSE. `Mark`, `Splash` and `Logo` are imported
 * from seven places across four packages — the launch splash, the error page, the legacy home, two
 * empty-state watermarks. Renaming them would be a rename with no reader; pointing them at
 * `jolli-brand.tsx` means every one of those surfaces rebrands without being visited, including
 * the ones this fork has not looked at yet.
 *
 * ⚠ `Mark` AND `Splash` ARE NOW THE SAME DRAWING. Upstream had two because its mark and its splash
 * were different crops of a square glyph; the Jolli mark is one piece of artwork that scales, and
 * every call site sizes it with a class anyway. The aspect ratio changes (upstream's were portrait,
 * this is slightly landscape) — every call site is a `w-`/`h-` box with `preserveAspectRatio`
 * doing the rest, so they letterbox rather than distort.
 *
 * ⚠ THE LOGOTYPE INHERITS `currentColor` INSTEAD OF READING `--icon-*`. All three of these render
 * as watermarks under an `opacity-1x` class, where "the colour of the text around it" is the right
 * answer and is what the theme tokens were approximating.
 */

import { type ComponentProps } from "solid-js"
import { JolliLogo, JolliMark } from "./jolli-brand"

export const Mark = (props: { class?: string }) => <JolliMark class={props.class} />

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => (
  <JolliMark ref={props.ref} class={props.class} />
)

export const Logo = (props: { class?: string }) => <JolliLogo class={props.class} />
