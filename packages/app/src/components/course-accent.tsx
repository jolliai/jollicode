/**
 * A COURSE'S COLOUR, AS THE BAR THE WEB MOCK USES.
 *
 * ⚠ THE SAME DEVICE AT THE SAME SHAPE (jolli-edu-design, `components/EduSidebar.tsx`): a short
 * rounded bar off the dataviz ramp, `h-4 w-1`. A student who has learned that CS 310 is the amber
 * one in the browser reads the same thing here without being told, which is the entire value of an
 * accent and the reason it must not be re-invented per surface.
 *
 * ⚠ IT REPLACED A KIND GLYPH, AND THAT SWAPPED WHAT THE ROW ANSWERS. The terminal icon said what
 * KIND of course this is, which is the same answer on every row of a list where every course is a
 * code course — so it identified nothing. The bar says WHICH course, which is the question a list
 * is for. The kind is still legible where it matters: this application only runs code courses.
 *
 * ⚠ DECORATIVE, AND MARKED SO. Colour alone never carries meaning here — the code is beside it in
 * every place this renders.
 */

import type { Accent } from "@/jolli/types"

export function CourseAccent(props: { accent: Accent; class?: string }) {
  return (
    <span
      aria-hidden="true"
      class={`shrink-0 rounded-full ${props.class ?? "h-4 w-1"}`}
      style={{ background: `var(--dataviz-cat-${props.accent})` }}
    />
  )
}
