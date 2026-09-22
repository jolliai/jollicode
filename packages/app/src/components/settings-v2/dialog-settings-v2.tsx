/**
 * ⚠ NO PROVIDERS TAB AND NO MODELS TAB IN THIS FORK. Both were settings a student cannot legitimately
 * have: the first connects API keys, the second hides and shows models from a list their professor
 * chose. Jolli decides what runs, which is the product, so the panes have nothing left to decide.
 *
 * ⚠ THE PANE COMPONENTS ARE LEFT IN THE TREE, unreferenced from here. They are upstream files this
 * fork will keep taking updates to, and deleting them widens the diff for no behaviour: nothing
 * reaches them once the tabs are gone.
 */
import { Component, createMemo, createSignal, startTransition } from "solid-js"
import { Dialog } from "@opencode-ai/ui/v2/dialog-v2"
import { TabsV2 } from "@opencode-ai/ui/v2/tabs-v2"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { SettingsGeneralV2 } from "./general"
import { SettingsKeybinds } from "../settings-keybinds"
import "./settings-v2.css"
import { useLayout } from "@/context/layout"
import { useTabs } from "@/context/tabs"
import { useServerSync } from "@/context/server-sync"

export const DialogSettings: Component<{
  sessionID?: string
  defaultValue?: string
}> = (props) => {
  const language = useLanguage()
  const platform = usePlatform()
  const layout = useLayout()
  const tabs = useTabs()
  const serverSync = useServerSync()
  const [tab, setTab] = createSignal(props.defaultValue ?? "general")
  const directory = createMemo(() => {
    const route = layout.route()
    if (route.type === "dir-new-sesssion") return route.dir
    if (route.type === "draft") {
      const draft = tabs.store.find((item) => item.type === "draft" && item.draftID === route.draftID)
      return draft?.type === "draft" ? draft.directory : undefined
    }
    if (route.type === "session") return serverSync().session.get(route.sessionId)?.directory
    return undefined
  })
  return (
    <Dialog size="x-large" variant="settings" class="settings-v2-dialog">
      <TabsV2
        orientation="vertical"
        variant="settings"
        value={tab()}
        onChange={(value) => void startTransition(() => setTab(value))}
        class="settings-v2"
      >
        <TabsV2.List>
          <div class="flex flex-col justify-between h-full w-full">
            <div class="flex flex-col gap-3 w-full">
              <div class="flex flex-col gap-3">
                <div class="flex flex-col gap-1.5">
                  <TabsV2.SectionTitle>{language.t("settings.section.desktop")}</TabsV2.SectionTitle>
                  <div class="flex flex-col gap-1.5 w-full">
                    <TabsV2.Trigger value="general">
                      <Icon name="sliders" />
                      {language.t("settings.tab.general")}
                    </TabsV2.Trigger>
                    <TabsV2.Trigger value="shortcuts">
                      <Icon name="keyboard" />
                      {language.t("settings.tab.shortcuts")}
                    </TabsV2.Trigger>
                  </div>
                </div>
                {/*
                 * ⚠ THE "SERVERS" SECTION IS GONE, AND IT IS NOT A LAYOUT SIMPLIFICATION. Upstream
                 * lets you point the app at several opencode backends — a local sidecar, a remote
                 * HTTP server, one over WSL — and that page was where you added and switched
                 * between them. Jolli Code has exactly one backend: the sidecar this app forks,
                 * configured against the Jolli gateway (`desktop/src/main/jolli-gateway.ts`). A
                 * page offering to add a second one offered a door that does not exist, in the same
                 * way the Providers and Models tabs did before it — Jolli decides what runs.
                 */}
              </div>
            </div>
            <div class="settings-v2-nav-footer">
              <span>{language.t("app.name.desktop")}</span>
              <span>v{platform.version}</span>
            </div>
          </div>
        </TabsV2.List>
        <TabsV2.Content value="general" class="settings-v2-panel">
          <SettingsGeneralV2 sessionID={props.sessionID} />
        </TabsV2.Content>
        <TabsV2.Content value="shortcuts" class="settings-v2-panel">
          <SettingsKeybinds v2 />
        </TabsV2.Content>
      </TabsV2>
    </Dialog>
  )
}
