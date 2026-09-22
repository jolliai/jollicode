import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, Show } from "solid-js"
import { Tips } from "./tips-view"
import { useBindings } from "../../keymap"
import { isJolliConnected } from "@opencode-ai/core/jolli/gateway-config"
import { Flag } from "@opencode-ai/core/flag/flag"

const id = "internal:home-tips"

function View(props: { api: TuiPluginApi; hidden: boolean; show: boolean; connected: boolean }) {
  useBindings(() => ({
    commands: [
      {
        name: "tips.toggle",
        title: props.hidden ? "Show tips" : "Hide tips",
        category: "System",
        namespace: "palette",
        run() {
          props.api.kv.set("tips_hidden", !props.api.kv.get("tips_hidden", false))
          props.api.ui.dialog.clear()
        },
      },
    ],
    bindings: props.api.tuiConfig.keybinds.get("tips.toggle"),
  }))

  return (
    <box width="100%" maxWidth={75} alignItems="center" paddingTop={3} flexShrink={1}>
      <Show when={props.show}>
        <Tips api={props.api} connected={props.connected} />
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      home_bottom() {
        const hidden = createMemo(() => api.kv.get("tips_hidden", false))
        const first = createMemo(() => api.state.session.count() === 0)
        /**
         * UNDER LOCKDOWN THIS ASKS ABOUT A CREDENTIAL; EVERYWHERE ELSE IT STAYS UPSTREAM'S QUESTION.
         *
         * ⚠ THE RESOLVED PROVIDER LIST IS THE WRONG SIGNAL FOR THIS FORK, AND THE TWO DISAGREE
         * EXACTLY WHERE IT MATTERS. A Jolli provider whose course catalogue could not be fetched has
         * no models and is dropped from `state.provider`, so a student who HAD signed in was told
         * to "Run /login to sign in" while `/login` answered "already signed in" — two answers to
         * one question, on one screen. `state.connected` is what `dialog-provider.tsx`,
         * `dialog-logout.tsx` and `local.tsx` all key off.
         *
         * ⚠ AND IT IS ASKED THROUGH `isJolliConnected`, NOT THE BARE `jolli` SLUG, which is the one
         * spelling that answer never carries: `/provider` reports one id per wire protocol and
         * deliberately not the auth id (`httpapi-provider.test.ts` pins `not.toContain(Brand.short)`).
         * Matching the slug made this read `false` for everybody, so the sign-in tip stayed on the
         * home screen of a student who was already signed in — the same contradiction, reintroduced
         * by the fix for it.
         *
         * ⚠ AND IT IS NOT A BLANKET REPLACEMENT, BECAUSE UPSTREAM'S CHECK ASKS SOMETHING ELSE:
         * "is a provider worth using connected", which is why it discounts the free `opencode` one.
         * A plain install resolves that provider without any credential, so reading `connected`
         * there would hide this tip from the people it was written for.
         */
        const connected = createMemo(() =>
          Flag.JOLLICODE_LOCKDOWN
            ? isJolliConnected(api.state.connected)
            : api.state.provider.some(
                (item) =>
                  item.id !== "opencode" || Object.values(item.models).some((model) => model.cost?.input !== 0),
              ),
        )
        const show = createMemo(() => (!first() || !connected()) && !hidden())
        return <View api={api} hidden={hidden()} show={show()} connected={connected()} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
