import { Tooltip } from "@opencode-ai/ui/tooltip"
import { WordmarkV2 } from "@opencode-ai/ui/v2/wordmark-v2"
import { Show, type Accessor } from "solid-js"
import { Portal } from "solid-js/web"
import { PromptInputV2Composer } from "@/components/prompt-input-v2"
import { PromptGitStatus, PromptWorkspaceSelector } from "@/components/prompt-workspace-selector"
import { PromptAssistantSelector, PromptCourseSelector } from "@/components/prompt-course-selector"
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
      <div
        data-component="session-new-design"
        class="relative flex-1 min-h-0 overflow-hidden rounded-[10px] bg-v2-background-bg-deep"
      >
        <div class="absolute inset-x-0 top-[25.375%] flex justify-center px-6">
          <div class={NEW_SESSION_CONTENT_WIDTH}>
            {/*
             * ⚠ NOT FULL-BLEED ANY MORE. Upstream stretched its wordmark across the whole 720px
             * content column, which works for a 7%-alpha watermark and does not for a logo drawn in
             * the brand's own colours: at that size the mark competes with the composer instead of
             * introducing it. Half the column reads as a hero.
             */}
            <WordmarkV2 class="mx-auto h-auto w-[58%] max-w-[420px] text-v2-background-bg-inverse" />
            <div class="mt-8 flex flex-col gap-8">
              <PromptInputV2Composer controller={props.input} />
              {/*
               * ⚠ THE TWO SELECTOR ROWS ARE ONE BLOCK, TIGHTLY SPACED, AND THEY USED TO SIT A FULL
               * `gap-8` APART LIKE THE COMPOSER ABOVE THEM. At that distance they read as two
               * unrelated settings floating under the box; they are two halves of one answer to
               * "where does this session happen", so they belong closer to each other than either
               * is to the composer.
               */}
              <div class="flex flex-col gap-2">
                {/* ⚠ ABOVE THE PROJECT ROW, BECAUSE IT IS THE PRIOR DECISION. Which course this is
                    for determines who may answer, on what models, and who may read it; which folder
                    it runs in is a detail settled afterwards. Reading top to bottom gives a student
                    the two in the order they actually make them. */}
                <div class="flex min-h-7 min-w-0 flex-col items-center justify-center gap-0 text-v2-text-text-faint sm:flex-row">
                  <PromptCourseSelector onDone={props.input.restoreFocus} />
                  <PromptAssistantSelector onDone={props.input.restoreFocus} />
                </div>
                <Show when={props.project.empty()}>
                  <PromptProjectAddButton controller={props.project} />
                </Show>
                <Show when={props.project.selected()}>
                  <div class="flex min-h-7 min-w-0 flex-col items-center justify-center gap-0 text-v2-text-text-faint sm:flex-row">
                    <PromptProjectSelector controller={props.project} placement="bottom" />
                    <Show
                      when={props.workspace.bar.visible()}
                      fallback={
                        <PromptGitStatus branch={props.workspace.bar.branch()} noGit={!props.workspace.project.git()} />
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
                  </div>
                </Show>
              </div>
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
