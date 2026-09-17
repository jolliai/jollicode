# Jolli Code — demo fork plan (desktop IDE)

> **Status.** Phase 0 done (builds and runs). The course/assistant/privacy UI described in
> `.claude/plans/parsed-splashing-axolotl.md` is built and green — typecheck clean, 724 unit + 41
> browser tests passing, no runtime errors.
>
> Models are locked down ahead of Phase 3: the app connects exactly one provider (the Jolli
> gateway, `packages/desktop/src/main/jolli-gateway.ts`, handed to the server as
> `OPENCODE_CONFIG_CONTENT`), the course assistant narrows within it, and every BYO route in the V2
> UI is gone — provider settings pane, models settings pane, "manage models", the unpaid free-models
> dialog and the "connect to 75+ providers" tip.
>
> **Phase 1 (branding) is done except the palette and the namespace** — see that section for the
> two items left. Nothing user-visible says "OpenCode" any more, the artwork is Jolli's, and the
> window, taskbar, tab and favicons carry the Jolli mark. Jolli sign-in (Phase 2) and the rest of
> the config lockdown (Phase 3) are **not** started.


Fork of [sst/opencode](https://github.com/sst/opencode) (MIT), cloned at upstream `9f8db119` (2026-09-09).
Goal: a runnable, branded **desktop agent IDE** to show prospective customers what the
professor/student product is. **Mock only** — not a production hardening pass.

**Scope: the desktop application only.** The TUI (`packages/tui`) is out of scope and gets no
branding, no lockdown, and no course work.

## What we're demonstrating

1. Student signs in to **their Jolli account** — no BYO API key.
2. Models are limited to those the **institution/course** allows.
3. Each session is scoped to a **course**, running a **professor-authored assistant**
   (instructions + guardrails) defined in the Jolli account.

## Architecture (surveyed at `9f8db119`)

| Package | What it is | Role here |
|---|---|---|
| `packages/desktop` | Electron 42 shell — `electron-vite` + `electron-builder`, `src/{main,preload,renderer}` | Branding, packaging, onboarding, updater |
| `packages/app` | SolidJS + Tailwind renderer (shared with web) | All the UI we change: pickers, settings, course chrome |
| `packages/ui`, `packages/session-ui` | Shared Solid component libraries | Theme tokens, icons |
| `packages/opencode` | The agent server + config/auth engine | Auth and lockdown work lands here |
| `packages/identity` | Brand marks (svg/png) | Logo swap |

The desktop app **spawns the opencode server as a sidecar** (`packages/desktop/src/main/server.ts`,
`sidecar.ts`). So the auth and config machinery below still underpins the IDE — the Electron app
is the presentation layer on top of it.

### Findings that shape the plan

- **Third-party org login is already built in.** `auth login <url>`
  ([`packages/opencode/src/cli/cmd/providers.ts:328`](packages/opencode/src/cli/cmd/providers.ts:328))
  fetches `<url>/.well-known/opencode`, runs the `auth.command` it declares, captures stdout as
  the token, and stores `{type:"wellknown", key, token}`. `WellKnown` is a first-class auth type
  in [`packages/opencode/src/auth/index.ts`](packages/opencode/src/auth/index.ts).
- **Remote org config is already built in.** On every config load
  ([`packages/opencode/src/config/config.ts:374`](packages/opencode/src/config/config.ts:374)),
  each `wellknown` credential re-fetches the endpoint and merges `config` / `remote_config`
  (a `{url, headers}` pair with variable substitution, so the student's token rides as a header)
  as the **base config layer** — carrying `provider`, model `whitelist`, `agent`, `permission`.
- **The app namespace is one constant.** `const app = "opencode"` in
  [`packages/core/src/global.ts:10`](packages/core/src/global.ts:10) drives every state dir.
- **There's a channel system.** `OPENCODE_CHANNEL` → `dev|beta|prod`, and
  `UPDATER_ENABLED = app.isPackaged && CHANNEL !== "dev"`
  ([`packages/desktop/src/main/constants.ts`](packages/desktop/src/main/constants.ts)).
  Running the dev channel already disables auto-update; only a *packaged* demo build needs care.
- **First-launch onboarding already exists** as a gated flow
  ([`packages/desktop/src/main/onboarding.ts`](packages/desktop/src/main/onboarding.ts),
  `FIRST_LAUNCH_ONBOARDING_COMPLETE_KEY`) — the natural insertion point for sign-in + course pick.

**Consequence:** requirements 1–3 are ~90% reachable through the gateway contract with no fork.
The fork is about **branding** and **closing the escape hatches** — the parts that can't be done
server-side.

### The one thing that genuinely requires a fork

Config precedence is `well-known → global → custom → project → inline`. Remote org config is the
**weakest** layer, and the desktop UI ships explicit BYO-provider paths:
[`dialog-connect-provider.tsx`](packages/app/src/components/dialog-connect-provider.tsx)
(with a `_custom` entry), [`dialog-custom-provider.tsx`](packages/app/src/components/dialog-custom-provider.tsx),
and the provider/model settings panes. A student can add their own key or override the model
whitelist, the assistant prompt, or the permission rules. For a product pitched on
instructor-set guardrails, that inversion is the demo's central credibility risk.

## Gateway

Per direction, **we are not building a mock gateway.** We code against its contract and ship a
local fixture that satisfies it, so swapping to the real gateway is a one-URL change.

Assumed contract at `GET /.well-known/opencode`:

```jsonc
{
  "auth": { "command": ["jolli", "auth", "token"], "env": "JOLLI_API_KEY" },
  "remote_config": {
    "url": "https://gateway.jolli.ai/v1/config?course={env:JOLLI_COURSE}",
    "headers": { "Authorization": "Bearer {env:JOLLI_API_KEY}" }
  },
  "config": { /* institution defaults: provider, whitelist, permission */ }
}
```

`remote_config` returns the course-scoped payload: gateway provider block, model `whitelist`,
and the professor's `agent` definitions.

## Phases

Each phase is independently demoable. Stop wherever the demo is good enough.

### Phase 0 — Get the desktop app running unmodified

Prove the toolchain before changing code. This is the riskiest unknown on Windows.
- Install Bun (not on PATH — see Prerequisites).
- `bun install` at the root, then `bun run dev` in `packages/desktop` (`electron-vite dev`,
  preceded by its `predev` script).
- Watch for: the vendored `@opencode-ai/client` tgz, `node-pty` / `@parcel/watcher` native
  optional deps, and the sidecar server spawn.
- Record the working commands in `jolli/DEV.md`.

**Exit:** upstream opencode desktop launches from source on this machine.

### Phase 1 — Rebrand to Jolli Code ✅ (palette and namespace outstanding)

Cosmetic, but it's the whole first impression of a desktop app.

**Done.**
- Artwork: `packages/ui/src/components/jolli-brand.tsx` is the only place the logo is drawn.
  `logo.tsx` (`Mark`/`Splash`/`Logo`) and `v2/components/wordmark-v2.tsx` are re-skins over it, so
  the launch splash, the error page and the empty-state watermarks rebranded without being visited.
  The new-session hero is the mark + logotype + "code" set in Inter — see `DEV.md`.
- Icons regenerated from the mark into `packages/desktop/icons/{dev,beta,prod}`,
  `packages/desktop/resources/icons`, `packages/app/public` and
  `packages/ui/src/assets/favicon` — recipe in `DEV.md`.
- Window title, taskbar/app name (`APP_NAMES` and the dev `setName` in `main/index.ts`), both
  `index.html` titles, the Windows app menu heading, and both `site.webmanifest` copies.
- Every user-visible string across all 63 locale files. Only `OpenCode Zen` survives, on purpose —
  it names a third party's product, and the dialog it appears in is unreachable now that BYO is
  gone.
- **Renamed only user-visible strings.** `@opencode-ai/*` imports, Effect service tags, the shiki
  theme id, `opencode.json`, the `opencode://` protocol and `ai.opencode.desktop*` (which is where
  `userData` lives — renaming it silently resets the demo machine's state) are all left alone.

**Left.**
- Theme tokens in `packages/ui` / `packages/app/src/index.css` to Jolli's palette. Note the theme
  named "opencode" now displays as "Jolli Code" (`packages/ui/src/theme/context.tsx`) but is still
  upstream's colours; the dataviz ramp ported from the web mock is the only Jolli colour in the
  app so far.
- `app = "opencode"` → `"jolli-code"` in `packages/core/src/global.ts`. Deliberately not done yet:
  it moves every state dir, so it wants doing at the same time as the `userData` path, once.
- Confirm the updater stays off for whatever build we demo (dev channel already disables it).

**Exit:** it launches as Jolli Code, with Jolli icons, title, and palette.

### Phase 2 — Jolli sign-in

- Local fixture serving the well-known contract, so login runs through the *real* upstream
  code path rather than faked UI.
- A **Jolli sign-in screen** in first-launch onboarding, replacing provider connection as the
  entry point. Stub the token exchange as a device-code flow — prints a code, polls, returns a
  token. This is the best-demoing moment in the product; worth doing properly even in a mock.
- Remove the BYO routes from the UI: the `_custom` entry and custom-provider form in
  `dialog-connect-provider.tsx` / `dialog-custom-provider.tsx`, and the provider panes in
  `settings-providers.tsx` / `settings-v2/providers.tsx`.

**Exit:** the only way into the app is a Jolli account.

### Phase 3 — Lockdown (the credibility phase)

- Make remote org config **authoritative** over global/project/inline for `provider`,
  `whitelist`/`enabled_providers`, `permission`, and the professor's `agent` definitions.
- Constrain the model surface — `dialog-select-model.tsx`, `dialog-manage-models.tsx`,
  `settings-models.tsx`, `context/models.tsx`, `hooks/use-providers.ts` — so nothing outside
  the course whitelist is reachable or even visible.

**Exit:** a student editing a local `opencode.json`, or poking at settings, cannot widen models,
weaken permissions, or alter the assistant prompt. Demo this live by trying to break it on stage.

### Phase 4 — Course scoping

This is where a desktop IDE beats a terminal — the scope can be *visible at all times*.
- Course selection in onboarding, and a persistent course switcher in the window chrome.
- Selected course drives the `remote_config` course parameter.
- Assistant shown in the composer: `CS 101 · Intro Assistant`, so every screenshot carries it.
- Professor assistants map onto OpenCode agents (`prompt`, `model`, `tools`, `permission`,
  `steps`) served from course config — no new concept needed; wire through
  [`context/local-agent.ts`](packages/app/src/context/local-agent.ts).

**Exit:** the window makes it obvious which course and which professor's assistant is active.

### Phase 5 — Prompt coaching ✅ (derived half; the writer is unwired)

Ported from the web mock's `app/src/components/chat/coach.ts` (jolli-edu-design), and the port is
deliberately **not** a copy — read that file's header before touching ours.

- `CoachingRubric` rides on `Assistant` beside `guardrails`: three switches plus the instructor's
  prose. **The professor authors it on the web; this surface only applies it.** There is no builder
  here and there should not be one.
- The gate ([`jolli/coaching.ts`](../packages/app/src/jolli/coaching.ts)) is deterministic. Each
  branch reads a count, a flag or an id; each rubric key contributes **at most one** nudge, so a
  reply carries none to three. Nothing in it says "that was fine" — the web mock shipped a round that
  fired on 80 of 80 answers and recorded why that was the bug.
- Nothing is shown inline. A tinted badge sits **first in the reply's own action row**, beside copy,
  and a HoverCard holds the notes — the web mock's `CoachBadge`, including its two states (unread
  spells it out, read is the icon and a digit) and its marking-read on close rather than on open,
  which it records as a reproduced flicker bug.
- **It is the one control in that row that does not fade.** The others are hover-only affordances a
  reader goes looking for; a coaching badge is an indicator nobody knows to look for, so it stays
  until it has been read and then behaves like its neighbours. This cost two edits outside
  `packages/app`, both marked `FORK`: a `coachBadge` prop threaded through `session-ui`'s
  `message-part.tsx`, and a CSS change moving that row's fade from the row onto its children —
  `opacity` on a parent caps every descendant, so a child cannot opt out of it.
- `graduation-cap` was added to `packages/ui`'s icon set (20x20, stroked, `currentColor`), since it
  had no education-shaped mark.
- Our third axis is `coachTheProcess`, replacing the web mock's `pointAtTheMaterials`. Naming a
  document you did not attach is an essay-shaped failure; a student here is in a repository, so the
  evidence is `Turn.tools` — edited without reading, changed code without running it, a tool failed.
- **The privacy rule is the load-bearing one.** Course staff read nudges off sessions a student
  withheld from them (`SessionSharing.staff` gates the session, not the nudge). That is survivable
  only because a nudge is metadata: a professor learns *how* their student worked, never *what* they
  wrote. So a model may see the exchange only when `sharing.staff` is already true, and
  `coachProseRequest` is the single constructor that applies it.
- The derived sentence is the floor, never a placeholder: it renders on first paint, and a writer
  that is absent, slow, failing or verbose leaves it standing.

**Unwired on purpose:** no `CoachWriter` is registered. This application has no route that runs a
model outside a session, and the gateway is what will write a nudge — the same posture
`AssistantGuardrails` already takes. Until one exists every student sees the derived sentence, which
is exactly the product the web mock ships, so the unwired state is a complete feature and not a stub.

**Exit:** a thin question leaves one tinted badge under the reply that stays put until it is read
and opens on hover or focus; an ordinary one leaves nothing there at all.


## Prerequisites

- **Bun** — not on PATH. Required; blocks Phase 0.
- **Go** — not needed. The repo has zero `.go` files.
- **gh** — installed but not yet visible to new processes; needs an app restart. Only needed to
  create the GitHub fork remote; local work is unblocked without it.

## Repo conventions

- `upstream` → `sst/opencode`. `origin` unset until the Jolli remote exists.
- Fork-specific docs live in `jolli/` to keep the upstream diff legible.
- Keep the MIT `LICENSE` and attribution intact.

## Deliberately out of scope

The TUI. Production auth, real gateway, code signing/notarization, FERPA/privacy review, LMS
integration, upstream-drift strategy, grading/telemetry.
