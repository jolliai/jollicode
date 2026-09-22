import { createEffect, createMemo, createSignal, onMount, Show } from "solid-js"
import { useSync } from "../context/sync"
import { map, pipe, sortBy } from "remeda"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useSDK } from "../context/sdk"
import { DialogPrompt } from "../ui/dialog-prompt"
import { Link } from "../ui/link"
import { useTheme } from "../context/theme"
import { TextAttributes } from "@opentui/core"
import type { ProviderAuthAuthorization, ProviderAuthMethod } from "@opencode-ai/sdk/v2"
import { DialogModel } from "./dialog-model"
import { DialogAlert } from "../ui/dialog-alert"
import { useToast } from "../ui/toast"
import { isConsoleManagedProvider } from "../util/provider-origin"
import { useConnected } from "./use-connected"
import { useBindings } from "../keymap"
import { useClipboard } from "../context/clipboard"
import { Brand } from "@opencode-ai/core/brand"
import { isJolliAuthOrProviderId, isJolliConnected } from "@opencode-ai/core/jolli/gateway-config"
import open from "open"

/**
 * "Is this provider connected?" — with the folded Jolli row treated as connected
 * when ANY of its per-protocol children is. `sync.data.provider_next.connected`
 * carries the per-protocol ids, not the folded `"jolli"` slug.
 */
function isProviderConnected(connected: readonly string[], providerID: string): boolean {
  if (providerID === Brand.short) return isJolliConnected(connected)
  return connected.includes(providerID)
}

const PROVIDER_PRIORITY: Record<string, number> = {
  [Brand.short]: 0,
  opencode: 1,
  "opencode-go": 2,
  openai: 3,
  "github-copilot": 4,
  anthropic: 5,
  google: 6,
}

type ProviderOption = {
  title: string
  value: string
  description?: string
  category: string
  providerID: string
}

/**
 * ⚠ THERE IS NO "OTHER" ENTRY ANY MORE, AND ITS ABSENCE IS THE POINT. Upstream ends this list with a
 * synthetic row that prompts for a provider id and writes a credential for it. That row does not go
 * through the provider list at all, so `enabled_providers` — which is the whole model lockdown —
 * never sees it: it was the one way a student could still attach their own key.
 *
 * ⚠ THE THREE PER-PROTOCOL JOLLI PROVIDERS FOLD INTO ONE UI ROW WHOSE VALUE IS `Brand.short`. The
 * opencode config emits `jolli-anthropic`, `jolli-openai`, `jolli-google` — three provider blocks
 * because each SDK npm needs its own — but the picker is a UX surface, and three identical "Jolli"
 * rows offering the same sign-in would be noise, not choice. The auth layer already thinks of
 * them as one credential (`plugin/jolli.ts` writes a single `"jolli"` entry that feeds every
 * block), so this fold mirrors that. Downstream checks that need "is Jolli connected" have to look
 * for ANY of the per-protocol ids — {@link isProviderConnected} does that.
 */
export function providerOptions(list: { id: string; name: string }[]): ProviderOption[] {
  const jolliPresent = list.some((provider) => isJolliAuthOrProviderId(provider.id))
  const withoutJolli = list.filter((provider) => !isJolliAuthOrProviderId(provider.id))
  const folded = jolliPresent ? [{ id: Brand.short, name: Brand.name }, ...withoutJolli] : withoutJolli
  return pipe(
    folded,
    sortBy(
      (x) => PROVIDER_PRIORITY[x.id] ?? 99,
      (x) => x.name.toLowerCase(),
      (x) => x.id,
    ),
    map((provider) => ({
      title: provider.name,
      value: provider.id,
      providerID: provider.id,
      description: {
        [Brand.short]: "Your school account",
        opencode: "(Recommended)",
        anthropic: "(API key)",
        openai: "(ChatGPT Plus/Pro or API key)",
        "opencode-go": "Low cost subscription for everyone",
      }[provider.id],
      category: provider.id in PROVIDER_PRIORITY ? "Popular" : "Providers",
    })),
  )
}

/**
 * Drives one provider's login, from picking an auth method to whichever dialog finishes it.
 *
 * Lifted out of the picker's `onSelect` because two callers need it: selecting a row, and the
 * picker skipping itself entirely when Jolli is the only provider there is.
 */
export function createProviderLogin() {
  const sync = useSync()
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()

  return async function startLogin(providerID: string) {
    const methods = sync.data.provider_auth[providerID] ?? [
      {
        type: "api",
        label: "API key",
      },
    ]
    let index: number | null = 0
    if (methods.length > 1) {
      index = await new Promise<number | null>((resolve) => {
        dialog.replace(
          () => (
            <DialogSelect
              title="Select auth method"
              options={methods.map((x, index) => ({
                title: x.label,
                value: index,
              }))}
              onSelect={(option) => resolve(option.value)}
            />
          ),
          () => resolve(null),
        )
      })
    }
    if (index == null) return
    const method = methods[index]
    if (method.type === "oauth") {
      let inputs: Record<string, string> | undefined
      if (method.prompts?.length) {
        const value = await PromptsMethod({
          dialog,
          prompts: method.prompts,
        })
        if (!value) return
        inputs = value
      }

      const result = await sdk.client.provider.oauth.authorize({
        providerID,
        method: index,
        inputs,
      })
      if (result.error) {
        toast.show({
          variant: "error",
          message: JSON.stringify(result.error),
        })
        dialog.clear()
        return
      }
      if (result.data?.method === "code") {
        dialog.replace(() => (
          <CodeMethod providerID={providerID} title={method.label} index={index} authorization={result.data!} />
        ))
      }
      if (result.data?.method === "auto") {
        dialog.replace(() => (
          <AutoMethod providerID={providerID} title={method.label} index={index} authorization={result.data!} />
        ))
      }
    }
    if (method.type === "api") {
      let metadata: Record<string, string> | undefined
      if (method.prompts?.length) {
        const value = await PromptsMethod({ dialog, prompts: method.prompts })
        if (!value) return
        metadata = value
      }
      return dialog.replace(() => <ApiMethod providerID={providerID} title={method.label} metadata={metadata} />)
    }
  }
}

export function createDialogProviderOptions() {
  const sync = useSync()
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  const { theme } = useTheme()
  const onboarded = useConnected()
  const startLogin = createProviderLogin()

  const options = createMemo(() => {
    return pipe(
      providerOptions(sync.data.provider_next.all),
      map((provider) => {
        const providerID = provider.providerID
        const consoleManaged = isConsoleManagedProvider(sync.data.console_state.consoleManagedProviders, providerID)
        // Folded Jolli row → check the per-protocol ids; other providers stay literal.
        const connected = isProviderConnected(sync.data.provider_next.connected, providerID)

        return {
          title: provider.title,
          value: provider.value,
          description: provider.description,
          footer: consoleManaged ? sync.data.console_state.activeOrgName : undefined,
          category: provider.category,
          gutter: connected && onboarded() ? () => <text fg={theme.success}>✓</text> : undefined,
          async onSelect() {
            if (consoleManaged) return
            return startLogin(providerID)
          },
        }
      }),
    )
  })
  return options
}

/**
 * What opening the provider picker should actually do.
 *
 * ⚠ WITH ONE PROVIDER THERE IS NOTHING TO PICK, SO THE PICKER GETS OUT OF THE WAY. Every entry
 * point into it goes through `DialogProvider` — startup, `/login`, the model dialog, the
 * composer's prompt — so deciding in this one place covers all of them.
 *
 * ⚠ SIGNED OUT, THE LIST IS EMPTY RATHER THAN SHORT. Jolli is not in models.dev, so it only appears
 * once a credential exists; without the `methods` check the student would be shown a dialog with no
 * rows and no way forward. The auth methods come from the plugin registry instead, which is
 * populated whether or not anyone has signed in.
 *
 * ⚠ AND SIGNED IN, THERE IS NOTHING TO DO EITHER. Sending a student who already has a credential
 * straight back out to a browser sign-in is not a provider picker doing its job — it is `/login`
 * with no way to see the state it is reporting on and nothing to cancel. Switching accounts goes
 * through an explicit sign-out first.
 *
 * `connected` is the honest signal for holding a credential on both surfaces: the bare CLI keeps
 * the JWT in `auth.json` under this provider id, while the desktop keeps it in the OS keychain and
 * declares the provider block from it — and the list route counts either one.
 */
/**
 * FETCH THE COURSE CATALOGUE BEFORE THE CONFIG THAT IS BUILT FROM IT.
 *
 * ⚠ THE JOLLI PROVIDER'S MODEL LIST IS CONFIG, ASSEMBLED BY `jolliLockdownConfig` FROM A CATALOGUE
 * IT LOADS ITSELF. A brand-new credential has nothing cached under it, so that load is a cold
 * network fetch — and `config.ts` deliberately swallows its failure rather than refusing to start a
 * server over a model list. The result is a provider declared with NO models, which is the composer
 * reading "No provider selected" the moment a student finishes signing in.
 *
 * ⚠ AND IT DOES NOT RECOVER ON ITS OWN, which is what makes this worth a round-trip. Config is
 * built once per instance: the catalogue arriving a second later — over this very route — leaves
 * `/provider` empty until something disposes the instance again. A student would be looking at
 * their course list and at "No provider selected" at the same time.
 *
 * ⚠ SO THE ORDER IS THE DESKTOP'S ORDER. Main fetches the catalogue and bakes the models into the
 * sidecar's config BEFORE forking it; this does the same thing across one process — ask once, let
 * the shared cache answer the config rebuild, and the two cannot disagree. `cache.ts` makes exactly
 * this argument for two processes; it holds just as well for two loads in one.
 *
 * ⚠ A FAILURE HERE IS NOT WORTH REPORTING. It means the rebuild will fetch for itself and may fail
 * too — the outcome this already was — and a student who just signed in successfully should not be
 * handed an error about a list they have not asked for yet.
 */
async function warmCatalog(sdk: ReturnType<typeof useSDK>, providerID: string) {
  // Fires for the folded Jolli row (`Brand.short`) as well as any per-protocol id, since the
  // completeLogin path can reach here through either identity depending on the caller.
  if (!isJolliAuthOrProviderId(providerID)) return
  await sdk.client.jolli.course().catch(() => undefined)
}

/**
 * EVERYTHING THAT HAPPENS AFTER A SIGN-IN SUCCEEDS, IN THE ORDER IT HAS TO HAPPEN IN.
 *
 * ⚠ THE SIGN-IN DIALOG IS CLOSED BEFORE THE STATE CHANGES, NOT AFTER, AND THAT ORDER IS A BUG FIX.
 * Closing last looks tidier and is wrong: `bootstrap()` is what makes the credential visible, and
 * `app.tsx` reacts to that by opening whatever the new state needs to say — the course gate for a
 * student with none, the picker for one with several. Clearing afterwards wiped the dialog that
 * had JUST opened, and the student was left on an empty screen. Closing first means the only thing
 * this function dismisses is its own.
 *
 * ⚠ UPSTREAM ENDS ON THE MODEL PICKER AND THIS FORK MUST NOT, FOR JOLLI. There, connecting a
 * provider was the student's act and picking one of its models is the natural next one. Here the
 * act was signing in to the only provider there is, and the model is not theirs to pick: an
 * assistant's `allowedModelIds` decides it, and no assistant is in force until a COURSE is chosen.
 * Opening the model picker here shows the whole tenant catalogue, under no grant, for a decision
 * the course is about to make anyway. Any other provider keeps upstream's ending, where none of
 * this reasoning applies.
 */
async function completeLogin(input: {
  sdk: ReturnType<typeof useSDK>
  sync: ReturnType<typeof useSync>
  dialog: ReturnType<typeof useDialog>
  providerID: string
}) {
  const jolli = isJolliAuthOrProviderId(input.providerID)
  if (jolli) input.dialog.clear()
  await warmCatalog(input.sdk, input.providerID)
  await input.sdk.client.instance.dispose()
  await input.sync.bootstrap()
  if (!jolli) input.dialog.replace(() => <DialogModel providerID={input.providerID} />)
}

export function connectAction(input: {
  providerIDs: string[]
  methods: ProviderAuthMethod[] | undefined
  connected: string[]
}) {
  if (input.providerIDs.length > 1) return "pick" as const
  if (input.providerIDs.length === 1 && !isJolliAuthOrProviderId(input.providerIDs[0])) return "pick" as const
  if (!input.methods) return "pick" as const
  return isProviderConnected(input.connected, Brand.short) ? ("signed-in" as const) : ("login" as const)
}

/**
 * @param confirm Ask before launching a browser. Set by the caller that opened this WITHOUT being
 *   asked to — see the effect below.
 */
export function DialogProvider(props: { confirm?: boolean } = {}) {
  const sync = useSync()
  const dialog = useDialog()
  const toast = useToast()
  const options = createDialogProviderOptions()
  const startLogin = createProviderLogin()
  const [confirming, setConfirming] = createSignal(false)

  const action = createMemo(() =>
    connectAction({
      providerIDs: options().map((option) => option.value),
      methods: sync.data.provider_auth[Brand.short],
      connected: sync.data.provider_next.connected,
    }),
  )

  /**
   * ⚠ AN EFFECT RATHER THAN `onMount`, BECAUSE THE ANSWER USUALLY ARRIVES AFTER THE DIALOG DOES.
   * `provider_auth` is fetched in the bootstrap's non-blocking second pass (`context/sync.tsx`), so
   * a picker opened from `/login`, the model dialog or the composer while the store is still
   * `partial` reads no methods and computes "pick". `onMount` has already returned by the time they
   * land, and the `Show` below stops matching as soon as they do — leaving the student looking at a
   * dialog with no rows, no login and nothing to cancel.
   *
   * ⚠ LATCHED, BECAUSE THE ACTION STAYS RESOLVED ONCE IT IS. Every later write to the provider
   * stores re-runs this; without the latch, signing in would re-enter `startLogin` and open a
   * second browser tab on the credential that just arrived.
   */
  let acted = false
  createEffect(() => {
    const resolved = action()
    if (acted || resolved === "pick") return
    acted = true
    if (resolved === "signed-in") {
      toast.show({ message: `Already signed in to ${Brand.name}`, variant: "info" })
      dialog.clear()
      return
    }
    /**
     * ⚠ AN OPEN NOBODY ASKED FOR ASKS FIRST; AN EXPLICIT ONE DOES NOT. `/login`, the model dialog
     * and the composer's warning all reach this because a student did something — sending them
     * straight to the browser is answering the request they made. Startup is the one caller that
     * opens this on its own (`app.tsx`, when sync completes with no providers), and there it went
     * from launching `jollicode` to a browser tab in ZERO keystrokes: no dialog to read, nothing to
     * cancel, and no way to tell whether the application had decided something on your behalf.
     *
     * ⚠ THE ALERT RENDERS FROM INSIDE THIS COMPONENT RATHER THAN REPLACING IT. `startLogin` is a
     * closure over this component's contexts and finishes the job by replacing the dialog itself;
     * handing the confirmation to a separate dialog would dispose the owner mid-flight for no gain.
     */
    if (props.confirm) return setConfirming(true)
    void startLogin(Brand.short)
  })

  return (
    <>
      <Show when={action() === "pick"}>
        <DialogSelect title="Connect a provider" options={options()} />
      </Show>
      <Show when={confirming()}>
        <DialogAlert
          title={`Sign in to ${Brand.name}`}
          message="Press enter to open your browser, or esc to skip and run /login later."
          onConfirm={() => void startLogin(Brand.short)}
        />
      </Show>
    </>
  )
}

interface AutoMethodProps {
  index: number
  providerID: string
  title: string
  authorization: ProviderAuthAuthorization
}
function AutoMethod(props: AutoMethodProps) {
  const { theme } = useTheme()
  const sdk = useSDK()
  const dialog = useDialog()
  const sync = useSync()
  const toast = useToast()
  const clipboard = useClipboard()

  useBindings(() => ({
    bindings: [
      {
        key: "c",
        desc: "Copy provider code",
        group: "Dialog",
        cmd: () => {
          const code =
            props.authorization.instructions.match(/[A-Z0-9]{4}-[A-Z0-9]{4,5}/)?.[0] ?? props.authorization.url
          clipboard
            .write?.(code)
            .then(() => toast.show({ message: "Copied to clipboard", variant: "info" }))
            .catch(toast.error)
        },
      },
    ],
  }))

  onMount(async () => {
    /**
     * ⚠ THE CLIENT OPENS THE BROWSER, NOT THE PLUGIN THAT BUILT THE URL. `authorize` runs inside the
     * opencode server, which for a remote `opencode serve` is not the machine anyone is looking at.
     * The TUI is the surface the user is actually sitting in front of, so it is the honest place to
     * launch a browser from. The link above stays as the fallback when the launch fails.
     */
    await open(props.authorization.url).catch(() => undefined)

    const result = await sdk.client.provider.oauth.callback({
      providerID: props.providerID,
      method: props.index,
    })
    if (result.error) {
      toast.show({
        variant: "error",
        message:
          "name" in result.error && result.error.name === "ProviderAuthOauthCallbackFailed"
            ? "Sign-in failed. Try /login again."
            : JSON.stringify(result.error),
      })
      dialog.clear()
      return
    }
    await completeLogin({ sdk, sync, dialog, providerID: props.providerID })
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {props.title}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <box gap={1}>
        <Link href={props.authorization.url} fg={theme.primary} />
        <text fg={theme.textMuted}>{props.authorization.instructions}</text>
      </box>
      <text fg={theme.textMuted}>Waiting for authorization…</text>
      <text fg={theme.text}>
        c <span style={{ fg: theme.textMuted }}>copy</span>
      </text>
    </box>
  )
}

interface CodeMethodProps {
  index: number
  title: string
  providerID: string
  authorization: ProviderAuthAuthorization
}
function CodeMethod(props: CodeMethodProps) {
  const { theme } = useTheme()
  const sdk = useSDK()
  const sync = useSync()
  const dialog = useDialog()
  const [error, setError] = createSignal(false)

  return (
    <DialogPrompt
      title={props.title}
      placeholder="Authorization code"
      onConfirm={async (value) => {
        const { error } = await sdk.client.provider.oauth.callback({
          providerID: props.providerID,
          method: props.index,
          code: value,
        })
        if (!error) {
          await sdk.client.instance.dispose()
          await sync.bootstrap()
          dialog.replace(() => <DialogModel providerID={props.providerID} />)
          return
        }
        setError(true)
      }}
      description={() => (
        <box gap={1}>
          <text fg={theme.textMuted}>{props.authorization.instructions}</text>
          <Link href={props.authorization.url} fg={theme.primary} />
          <Show when={error()}>
            <text fg={theme.error}>Invalid code</text>
          </Show>
        </box>
      )}
    />
  )
}

interface ApiMethodProps {
  providerID: string
  title: string
  metadata?: Record<string, string>
}
function ApiMethod(props: ApiMethodProps) {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const toast = useToast()
  const { theme } = useTheme()

  return (
    <DialogPrompt
      title={props.title}
      placeholder="API key"
      description={() =>
        ({
          opencode: (
            <box gap={1}>
              <text fg={theme.textMuted}>
                OpenCode Zen gives you access to all the best coding models at the cheapest prices with a single API
                key.
              </text>
              <text fg={theme.text}>
                Go to <span style={{ fg: theme.primary }}>https://opencode.ai/zen</span> to get a key
              </text>
            </box>
          ),
          "opencode-go": (
            <box gap={1}>
              <text fg={theme.textMuted}>
                OpenCode Go is a $10 per month subscription that provides reliable access to popular open coding models
                with generous usage limits.
              </text>
              <text fg={theme.text}>
                Go to <span style={{ fg: theme.primary }}>https://opencode.ai/go</span> and enable OpenCode Go
              </text>
            </box>
          ),
        })[props.providerID] ?? undefined
      }
      onConfirm={async (value) => {
        if (!value) return
        await sdk.client.auth.set({
          providerID: props.providerID,
          auth: {
            type: "api",
            key: value,
            ...(props.metadata ? { metadata: props.metadata } : {}),
          },
        })
        await completeLogin({ sdk, sync, dialog, providerID: props.providerID })
      }}
    />
  )
}

interface PromptsMethodProps {
  dialog: ReturnType<typeof useDialog>
  prompts: NonNullable<ProviderAuthMethod["prompts"]>[number][]
}
async function PromptsMethod(props: PromptsMethodProps) {
  const inputs: Record<string, string> = {}
  for (const prompt of props.prompts) {
    if (prompt.when) {
      const value = inputs[prompt.when.key]
      if (value === undefined) continue
      const matches = prompt.when.op === "eq" ? value === prompt.when.value : value !== prompt.when.value
      if (!matches) continue
    }

    if (prompt.type === "select") {
      const value = await new Promise<string | null>((resolve) => {
        props.dialog.replace(
          () => (
            <DialogSelect
              title={prompt.message}
              options={prompt.options.map((x) => ({
                title: x.label,
                value: x.value,
                description: x.hint,
              }))}
              onSelect={(option) => resolve(option.value)}
            />
          ),
          () => resolve(null),
        )
      })
      if (value === null) return null
      inputs[prompt.key] = value
      continue
    }

    const value = await new Promise<string | null>((resolve) => {
      props.dialog.replace(
        () => (
          <DialogPrompt title={prompt.message} placeholder={prompt.placeholder} onConfirm={(value) => resolve(value)} />
        ),
        () => resolve(null),
      )
    })
    if (value === null) return null
    inputs[prompt.key] = value
  }
  return inputs
}
