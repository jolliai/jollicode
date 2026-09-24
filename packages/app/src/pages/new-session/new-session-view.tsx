import { Tooltip } from "@opencode-ai/ui/tooltip"
import { WordmarkV2 } from "@opencode-ai/ui/v2/wordmark-v2"
import { Show, type Accessor } from "solid-js"
import { Portal } from "solid-js/web"
import { PromptInputV2Composer } from "@/components/prompt-input-v2"
import { PromptGitStatus, PromptWorkspaceSelector } from "@/components/prompt-workspace-selector"
import {
  PromptProjectAddButton,
  PromptProjectSelector,
  type PromptProjectController,
} from "@/components/prompt-project-selector"
import { StatusPopoverV2 } from "@/components/status-popover"
import { useLanguage } from "@/context/language"
import { NEW_SESSION_CONTENT_WIDTH } from "@/pages/session/new-session-layout"
import type { NewSessionDraftController } from "./new-session-draft-controller"
import type { NewSessionWorkspaceController } from "./new-session-workspace-controller"

export function NewSessionView(props: {
  input: NewSessionDraftController["input"]
  project: PromptProjectController
  workspace: NewSessionWorkspaceController
}) {
  return (
    <div class="@container relative flex flex-col min-h-0 h-full flex-1">
      {/*
       * ⚠ `bg-base` LIKE EVERY OTHER PANE, NOT `bg-deep`. This is content — the place a student
       * starts writing — and `bg-deep` is the chrome behind content: the sidebar and the titlebar.
       * The two were interchangeable while `bg-deep` was `#fafafa` under a `#ffffff` pane; once it
       * became a real step down (`ui/v2/styles/theme.css`) this pane started reading as a hole in
       * the window beside the session and home views it switches with.
       *
       * ⚠ AND NO RADIUS, for the reason `SessionPanelFrame` gives: the pane is flush to the
       * sidebar now, so there is nothing behind a rounded corner but the window.
       */}
      <div data-component="session-new-design" class="relative flex-1 min-h-0 overflow-hidden bg-v2-background-bg-base">
        <div class="absolute inset-x-0 top-[25.375%] flex justify-center px-6">
          <div class={NEW_SESSION_CONTENT_WIDTH}>
            {/*
             * ⚠ NOT FULL-BLEED ANY MORE. Upstream stretched its wordmark across the whole 720px
             * content column, which works for a 7%-alpha watermark and does not for a logo drawn in
             * the brand's own colours: at that size the mark competes with the composer instead of
             * introducing it. Half the column reads as a hero.
             */}
            <WordmarkV2 class="mx-auto h-auto w-[58%] max-w-[420px] text-v2-background-bg-inverse" />
            {/*
             * ⚠ NOTHING SITS UNDER THE BOX ANY MORE, AND THE COLUMN THAT HELD IT WENT WITH IT. The
             * course and assistant row moved above the input (into `PromptInputV2Composer`, so a
             * live session gets it too); the project, workspace and branch row has now joined it
             * there as `courseBarTrailing`. What is left is a single child, so the `flex flex-col
             * gap-8` that spaced three of them is a claim about structure that is no longer true.
             */}
            <div class="mt-8">
              {/*
               * WHERE THIS SESSION HAPPENS, AS ONE LINE ABOVE THE BOX: course / assistant / project
               * / branch, coarse to fine.
               *
               * ⚠ THE WORKSPACE PICKER NEVER SHOWS. `workspaceBarEnabled` is off on every channel, so
               * `bar.visible()` is always false and the fallback — the branch — takes its place.
               *
               * ⚠ IT IS PASSED IN RATHER THAN IMPORTED BY THE BAR, because these three controls are
               * this route's — `props.project` and `props.workspace` are controllers the draft page
               * owns, and a live session has neither. See the `trailing` note in
               * `session-course-bar.tsx`.
               *
               * ⚠ AND THE FRAGMENT OPENS WITH A DIVIDER, because every control in this row owns the
               * `/` BEFORE it (`PromptAssistantSelector`, `PromptWorkspaceSelector`,
               * `PromptGitStatus` all do). Without one the project chip would butt straight against
               * the assistant's name.
               */}
              <PromptInputV2Composer
                controller={props.input}
                courseBarTrailing={
                  <>
                    <span class="mx-1 hidden select-none opacity-50 sm:inline">/</span>
                    {/*
                     * ⚠ ONE `Show` WITH A FALLBACK RATHER THAN TWO, WHICH IS ALSO A CORRECTNESS
                     * POINT AND NOT ONLY BREVITY. `selected()` is `current() ?? available[0]`, so it
                     * is defined exactly when `empty()` is false — the two branches were already
                     * mutually exclusive, and saying so keeps a single divider correct for both.
                     */}
                    <Show
                      when={props.project.selected()}
                      fallback={<PromptProjectAddButton controller={props.project} />}
                    >
                      <PromptProjectSelector controller={props.project} placement="bottom" />
                      <Show
                        when={props.workspace.bar.visible()}
                        fallback={
                          <PromptGitStatus
                            branch={props.workspace.bar.branch()}
                            noGit={!props.workspace.project.git()}
                          />
                        }
                      >
                        <PromptWorkspaceSelector
                          value={props.workspace.selection.value()}
                          projectRoot={props.workspace.project.root()}
                          workspaces={props.workspace.project.workspaces()}
                          branch={props.workspace.bar.branch()}
                          onChange={props.workspace.selection.set}
                          onDone={props.input.restoreFocus}
                        />
                      </Show>
                    </Show>
                  </>
                }
              />
            </div>
          </div>
        </div>
        {/*
         * ⚠ THE "CONNECT TO 75+ PROVIDERS" TIP IS GONE, AND WITH IT ITS COMPONENT. A student cannot
         * connect a provider — Jolli is the only one, declared as server config
         * (`desktop/src/main/jolli-gateway.ts`) — so the tip offered a door that no longer exists.
         *
         * ⚠ DELETED RATHER THAN LEFT TO ITS OWN CONDITION. It only rendered when `providers.paid()`
         * was empty, which the gateway config makes false, so it was already invisible in the app.
         * That is exactly the kind of accidental safety this fork should not rely on: a server
         * started without the config would have put the door back.
         */}
      </div>
    </div>
  )
}

export function NewSessionStatus(props: { mount: Accessor<HTMLElement | null>; visible: Accessor<boolean> }) {
  const language = useLanguage()

  return (
    <Show when={props.mount()} keyed>
      {(mount) => (
        <Portal mount={mount}>
          <Show when={props.visible()}>
            <Tooltip placement="bottom" value={language.t("status.popover.trigger")}>
              <StatusPopoverV2 />
            </Tooltip>
          </Show>
        </Portal>
      )}
    </Show>
  )
}
