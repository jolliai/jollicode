import { join } from "node:path"
import { app, BrowserWindow, dialog, shell } from "electron"
import type { DesktopMenuAction } from "@opencode-ai/app/desktop-menu"
import { getLogger } from "./logging"
import { nativeT } from "./native-translations"
import { createMainWindow, updateTitlebar } from "./windows"

export type DesktopMenuActionHandlers = Partial<{
  checkForUpdates: () => void
  relaunch: () => void
}>

export function runDesktopMenuAction(
  win: BrowserWindow | null,
  action: DesktopMenuAction,
  handlers: DesktopMenuActionHandlers = {},
) {
  switch (action) {
    case "app.checkForUpdates":
      handlers.checkForUpdates?.()
      return
    case "app.relaunch":
      handlers.relaunch?.()
      return
    case "app.openLicenses":
      void openLicenses()
      return
    case "window.new":
      createMainWindow()
      return
    case "window.close":
      win?.close()
      return
    case "window.minimize":
      win?.minimize()
      return
    case "window.toggleMaximize":
      if (win?.isMaximized()) {
        win.unmaximize()
        return
      }
      win?.maximize()
      return
    case "view.reload":
      win?.reload()
      return
    case "view.toggleDevTools":
      win?.webContents.toggleDevTools()
      return
    case "view.resetZoom":
      setZoom(win, 1)
      return
    case "view.zoomIn":
      setZoom(win, (win?.webContents.getZoomFactor() ?? 1) + 0.2)
      return
    case "view.zoomOut":
      setZoom(win, (win?.webContents.getZoomFactor() ?? 1) - 0.2)
      return
    case "view.toggleFullscreen":
      win?.setFullScreen(!win.isFullScreen())
      return
    case "edit.undo":
      win?.webContents.undo()
      return
    case "edit.redo":
      win?.webContents.redo()
      return
    case "edit.cut":
      win?.webContents.cut()
      return
    case "edit.copy":
      win?.webContents.copy()
      return
    case "edit.paste":
      win?.webContents.paste()
      return
    case "edit.delete":
      win?.webContents.delete()
      return
    case "edit.selectAll":
      win?.webContents.selectAll()
      return
  }
}

// NOTICE plus the bundled-package manifest, written by scripts/licenses.ts. Packaged builds carry it in
// resources/; an unpackaged run opens the copy `bun run build` left in out/licenses, which
// `electron-vite dev` never writes.
async function openLicenses() {
  const dir = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "out", "licenses")
  const file = join(dir, "THIRD-PARTY-LICENSES.txt")
  const error = await shell.openPath(file)
  if (!error) return
  getLogger().error("failed to open third-party licenses", { file, error })
  await dialog.showMessageBox({
    type: "error",
    message: nativeT("desktop.licenses.openFailed"),
    // The OS error is untranslated, and the build hint is for developers: only an unpackaged run is
    // expected to get here.
    detail: [
      `${file}: ${error}`,
      ...(app.isPackaged ? [] : ["Run `bun run build` in packages/desktop to write it."]),
    ].join("\n"),
  })
}

function setZoom(win: BrowserWindow | null, value: number) {
  if (!win) return
  win.webContents.setZoomFactor(Math.min(Math.max(value, 0.2), 10))
  updateTitlebar(win)
}
