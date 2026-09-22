/**
 * ONE ROW SHAPE FOR EVERY LIST IN THE SIDEBAR.
 *
 * ⚠ MOVED HERE FROM `pages/home/home-projects-view.tsx`, WHERE IT WAS ALREADY BEING EXPORTED FOR
 * REUSE. Courses, sessions, projects, servers and the account row all sit in one 300px column, and
 * a second hand-written copy of this style is precisely how they stop reading as siblings. The file
 * it came from re-exports the old name so the existing call sites did not have to move with it.
 *
 * ⚠ `cursor-default`, NOT `cursor-pointer`, AND THAT IS DELIBERATE UPSTREAM STYLE. These are
 * navigation rows in an application chrome, not links in a document.
 */

import { splitProps, type JSX } from "solid-js"

/** Truncate-to-fit for the row's text, so a long project or session name cannot widen the column. */
export const APP_SIDEBAR_ROW_LABEL = "min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap"

export function AppSidebarRow(props: JSX.ButtonHTMLAttributes<HTMLButtonElement>) {
  const [local, rest] = splitProps(props, ["class", "classList", "children"])
  return (
    <button
      {...rest}
      class={`
        flex h-7 min-w-0 w-full shrink-0 cursor-default items-center gap-2 rounded-[6px] bg-transparent px-1.5 text-left
        text-v2-text-text-muted [font-weight:440] transition-[background-color,color,box-shadow] duration-[120ms] ease-in-out
        hover:bg-v2-background-bg-layer-01 hover:text-v2-text-text-base
        data-[selected]:bg-v2-background-bg-layer-03 data-[selected]:text-v2-text-text-base
        data-[selected]:hover:bg-v2-background-bg-layer-03
        focus-visible:bg-v2-background-bg-layer-01 focus-visible:text-v2-text-text-base focus-visible:outline-none
        focus-visible:[box-shadow:inset_0_0_0_0.5px_var(--v2-border-border-muted)]
        ${local.class ?? ""}
      `}
      classList={local.classList}
    >
      {local.children}
    </button>
  )
}
