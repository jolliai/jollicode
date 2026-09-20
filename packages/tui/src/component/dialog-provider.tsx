import { createMemo, createSignal, onMount, Show } from "solid-js"
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
import { useToast } from "../ui/toast"
import { isConsoleManagedProvider } from "../util/provider-origin"
import { useConnected } from "./use-connected"
import { useBindings } from "../keymap"
import { useClipboard } from "../context/clipboard"
import { Brand } from "@opencode-ai/core/brand"
import open from "open"

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
 */
export function providerOptions(list: { id: string; name: string }[]): ProviderOption[] {
  return pipe(
    list,
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
      return dialog.replace(() => (
        <ApiMethod providerID={providerID} title={method.label} metadata={metadata} />
      ))
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
        const connected = sync.data.provider_next.connected.includes(providerID)

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
 * point into it goes through `DialogProvider` — startup, `/connect`, the model dialog, the
 * composer's prompt — so deciding in this one place covers all of them.
 *
 * ⚠ SIGNED OUT, THE LIST IS EMPTY RATHER THAN SHORT. Jolli is not in models.dev, so it only appears
 * once a credential exists; without the `methods` check the student would be shown a dialog with no
 * rows and no way forward. The auth methods come from the plugin registry instead, which is
 * populated whether or not anyone has signed in.
 *
 * ⚠ AND SIGNED IN, THERE IS NOTHING TO DO EITHER. Sending a student who already has a credential
 * straight back out to a browser sign-in is not a provider picker doing its job — it is `/connect`
 * with no way to see the state it is reporting on and nothing to cancel. Switching accounts goes
 * through an explicit sign-out first.
 *
 * `connected` is the honest signal for holding a credential on both surfaces: the bare CLI keeps
 * the JWT in `auth.json` under this provider id, while the desktop keeps it in the OS keychain and
 * declares the provider block from it — and the list route counts either one.
 */
export function connectAction(input: {
  providerIDs: string[]
  methods: ProviderAuthMethod[] | undefined
  connected: string[]
}) {
  if (input.providerIDs.length > 1) return "pick" as const
  if (input.providerIDs.length === 1 && input.providerIDs[0] !== Brand.short) return "pick" as const
  if (!input.methods) return "pick" as const
  return input.connected.includes(Brand.short) ? ("signed-in" as const) : ("login" as const)
}

export function DialogProvider() {
  const sync = useSync()
  const dialog = useDialog()
  const toast = useToast()
  const options = createDialogProviderOptions()
  const startLogin = createProviderLogin()

  const action = createMemo(() =>
    connectAction({
      providerIDs: options().map((option) => option.value),
      methods: sync.data.provider_auth[Brand.short],
      connected: sync.data.provider_next.connected,
    }),
  )

  onMount(() => {
    if (action() === "pick") return
    if (action() === "login") return void startLogin(Brand.short)
    toast.show({ message: `Already signed in to ${Brand.name}`, variant: "info" })
    dialog.clear()
  })

  return (
    <Show when={action() === "pick"}>
      <DialogSelect title="Connect a provider" options={options()} />
    </Show>
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
            ? "OAuth authorization failed. Try /connect again."
            : JSON.stringify(result.error),
      })
      dialog.clear()
      return
    }
    await sdk.client.instance.dispose()
    await sync.bootstrap()
    dialog.replace(() => <DialogModel providerID={props.providerID} />)
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
        await sdk.client.instance.dispose()
        await sync.bootstrap()
        dialog.replace(() => <DialogModel providerID={props.providerID} />)
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
