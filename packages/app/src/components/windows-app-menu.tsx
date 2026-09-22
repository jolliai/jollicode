/**
 * THE DESKTOP MENU ON WINDOWS AND LINUX, WHERE THERE IS NO SYSTEM MENU BAR TO PUT IT IN.
 *
 * ⚠ THE V2 TITLEBAR SHOWS IT AS A MENU BAR — File, Edit, View, … spelled out — RATHER THAN BEHIND A
 * HAMBURGER. Every Windows application a student already uses, this product's peers included, puts
 * its menus on the titlebar; a `≡` that opens a list of submenus is one extra click and one extra
 * guess in front of the same menus, and it hides the words that tell you which one you want. The
 * legacy titlebar keeps the icon, because it has no room to spell anything out.
 *
 * ⚠ ONE `DropdownMenu` PER TOP-LEVEL MENU, SHARING ONE `open` SIGNAL. That is what makes it a menu
 * bar rather than five unrelated buttons: with any menu open, moving the pointer across the others
 * switches to them, which is the behaviour every native menu bar has and the thing people do without
 * thinking. A single root with submenus — what the hamburger uses — cannot do it, because its top
 * level is a list rather than a row.
 *
 * ⚠ AND BOTH SHAPES ARE BUILT FROM THE SAME `DESKTOP_MENU`, which is also what the native macOS menu
 * is built from. Whatever is added there appears in all three without being written out again.
 */

import { createSignal, For, Show, type JSX } from "solid-js"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"

import { useCommand } from "@/context/command"
import {
  DESKTOP_MENU,
  desktopMenuVisible,
  type DesktopMenu,
  type DesktopMenuAction,
  type DesktopMenuEntry,
} from "@/desktop-menu"
import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"

const MENU_BAR_TRIGGER_CLASS = `
  flex h-7 shrink-0 cursor-default items-center whitespace-nowrap rounded-[6px] px-2
  text-v2-text-text-muted [font-weight:440] transition-[background-color,color] duration-[120ms] ease-in-out
  hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base
  focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none
  data-[expanded]:bg-v2-overlay-simple-overlay-pressed data-[expanded]:text-v2-text-text-base
`

export function WindowsAppMenu(props: {
  command: ReturnType<typeof useCommand>
  platform: ReturnType<typeof usePlatform>
  variant?: "legacy" | "v2"
}) {
  let lastFocused: HTMLElement | undefined
  const language = useLanguage()
  /** Which top-level menu is down. One signal for the whole bar — see the header note on switching. */
  const [open, setOpen] = createSignal<string | undefined>()

  /**
   * ⚠ WHAT HAD FOCUS BEFORE THE MENU TOOK IT, RECORDED ON THE WAY IN. The Edit menu's entries act on
   * the focused element, and by the time one is chosen the focused element is the menu. Pointer-down
   * and key-down rather than on open, because opening is already too late.
   */
  const rememberFocus = () => {
    const active = document.activeElement
    lastFocused = active instanceof HTMLElement ? active : undefined
  }
  const commandDisabled = (id: string) => {
    const option = props.command.options.find((option) => option.id === id)
    if (!option) return true
    return option.disabled ?? false
  }
  const runCommand = (id: string) => {
    if (commandDisabled(id)) return
    props.command.trigger(id)
  }
  const runAction = (action: DesktopMenuAction) => {
    if (action.startsWith("edit.") && lastFocused?.isConnected) lastFocused.focus({ preventScroll: true })
    void props.platform.runDesktopMenuAction?.(action)
  }
  const runEntry = (entry: DesktopMenuEntry) => {
    if (entry.type === "separator") return
    if (entry.command) {
      runCommand(entry.command)
      return
    }
    if (entry.action) {
      runAction(entry.action)
      return
    }
    if (entry.href) props.platform.openExternal(entry.href)
  }

  const menus = () => DESKTOP_MENU.filter((menu) => desktopMenuVisible(menu, "windows"))
  const entries = (menu: DesktopMenu) => (menu.items ?? []).filter((entry) => desktopMenuVisible(entry, "windows"))
  const renderEntry = (entry: DesktopMenuEntry) =>
    entry.type === "separator" ? (
      <DropdownMenu.Separator />
    ) : (
      <DesktopMenuItem
        label={entry.labelKey ? language.t(entry.labelKey) : ""}
        keybind={entry.command ? props.command.keybind(entry.command) : entry.accelerator?.windows}
        disabled={entry.command ? commandDisabled(entry.command) : false}
        onSelect={() => runEntry(entry)}
      />
    )

  return (
    <Show
      when={props.variant === "v2"}
      fallback={
        <DropdownMenu gutter={4} modal={false} placement="bottom-start">
          <DropdownMenu.Trigger
            as={IconButton}
            icon="menu"
            variant="ghost"
            class="titlebar-icon rounded-md shrink-0"
            aria-label={language.t("desktop.menu.ariaLabel")}
            onPointerDown={rememberFocus}
            onKeyDown={rememberFocus}
          />
          <DropdownMenu.Portal>
            <DropdownMenu.Content class="desktop-app-menu">
              <DropdownMenu.Group>
                <DropdownMenu.GroupLabel class="desktop-app-menu-heading">Jolli Code</DropdownMenu.GroupLabel>
                <For each={menus()}>
                  {(menu) => (
                    <DesktopMenuSubmenu label={language.t(menu.labelKey)}>
                      {entries(menu).map(renderEntry)}
                    </DesktopMenuSubmenu>
                  )}
                </For>
              </DropdownMenu.Group>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu>
      }
    >
      <div
        data-component="desktop-menu-bar"
        aria-label={language.t("desktop.menu.ariaLabel")}
        class="flex min-w-0 shrink items-center gap-0 overflow-hidden"
      >
        <For each={menus()}>
          {(menu) => (
            <DropdownMenu
              gutter={4}
              modal={false}
              placement="bottom-start"
              open={open() === menu.id}
              /**
               * ⚠ THE CLOSE BRANCH ONLY LISTENS TO THE MENU THAT IS ACTUALLY OPEN. Switching menus
               * flips one root's `open` to false and another's to true in the same update, and the
               * losing root answers with `onOpenChange(false)` — which, taken at face value, would
               * immediately shut the menu that had just been asked to open. Ignoring a close from a
               * menu that is no longer the current one is what makes hover-switching land.
               */
              onOpenChange={(next) =>
                setOpen((current) => (next ? menu.id : current === menu.id ? undefined : current))
              }
            >
              <DropdownMenu.Trigger
                class={MENU_BAR_TRIGGER_CLASS}
                onPointerDown={rememberFocus}
                onKeyDown={rememberFocus}
                /**
                 * ⚠ HOVER OPENS ONLY ONCE THE BAR IS ALREADY ACTIVE. A menu bar that dropped a menu
                 * on plain hover would fire every time the pointer crossed the titlebar on its way
                 * to the window controls.
                 */
                onPointerEnter={() => {
                  if (open() === undefined) return
                  setOpen(menu.id)
                }}
              >
                {language.t(menu.labelKey)}
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content class="desktop-app-menu">{entries(menu).map(renderEntry)}</DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu>
          )}
        </For>
      </div>
    </Show>
  )
}

function DesktopMenuSubmenu(props: { label: string; children: JSX.Element }) {
  return (
    <DropdownMenu.Sub>
      <DropdownMenu.SubTrigger>
        <span data-slot="dropdown-menu-item-label">{props.label}</span>
        <span data-slot="desktop-app-menu-chevron">
          <Icon name="chevron-right" size="small" />
        </span>
      </DropdownMenu.SubTrigger>
      <DropdownMenu.Portal>
        <DropdownMenu.SubContent class="desktop-app-menu">{props.children}</DropdownMenu.SubContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Sub>
  )
}

function DesktopMenuItem(props: { label: string; keybind?: string; disabled?: boolean; onSelect: () => void }) {
  return (
    <DropdownMenu.Item disabled={props.disabled} onSelect={props.onSelect}>
      <DropdownMenu.ItemLabel>{props.label}</DropdownMenu.ItemLabel>
      <Show when={props.keybind}>
        <span data-slot="desktop-app-menu-keybind">{props.keybind}</span>
      </Show>
    </DropdownMenu.Item>
  )
}
