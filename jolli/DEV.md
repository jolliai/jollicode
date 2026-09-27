# Dev setup (Windows)

Verified 2026-09-09 on Windows 11, upstream `9f8db119`.

## Toolchain

| Tool          | Status                                                          |
| ------------- | --------------------------------------------------------------- |
| Bun 1.4.2     | `C:\Users\<user>\.bun\bin\bun.exe` — required                   |
| gh            | `C:\Program Files\GitHub CLI\gh.exe` — only for the fork remote |
| Go            | **not needed** — the repo has zero `.go` files                  |
| Python / MSVC | **not needed** — see the tree-sitter note below                 |

## Install

```bash
bun install
```

Bun uses the **isolated linker** here: the real store is `node_modules/.bun` (~2,364 packages)
and each workspace gets symlinks. Root `node_modules` holding only ~18 entries is correct, not
a broken install — check `packages/<name>/node_modules` when verifying a dependency.

### Fork delta: native tree-sitter builds removed from `trustedDependencies`

`tree-sitter`, `tree-sitter-bash`, and `tree-sitter-powershell` were dropped from
`trustedDependencies` in [`package.json`](../package.json).

Their postinstalls run node-gyp, which needs Python ≥3.6 and MSVC build tools — neither is
present on this machine (`python` resolves to the Microsoft Store stub, no `py` launcher, no
Visual Studio installer), and installing them is a multi-GB detour.

They aren't needed. Every tree-sitter use in source goes through `web-tree-sitter` and `.wasm`
files — see [`packages/opencode/src/tool/shell.ts:312-325`](../packages/opencode/src/tool/shell.ts:312).
Nothing imports the native bindings. `electron`, `esbuild`, `node-pty`, `protobufjs`, and
`web-tree-sitter` stay trusted so their postinstalls still run.

Revisit only if something starts importing a native tree-sitter binding.

### Gotcha: Electron binary may not download

Bun runs postinstall scripts only for _freshly installed_ packages. If an earlier `bun install`
crashed after extracting `electron` but before running its script, a later successful install
will skip it and leave `electron.exe` missing.

Symptom: `packages/desktop/node_modules/electron` exists but has no `dist/` and no `path.txt`.

Fix — run the install script directly in the store directory:

```bash
cd "node_modules/.bun/electron@<version>+<hash>/node_modules/electron" && bun install.js
```

Verify with `dist/electron.exe --version` → `v42.3.3` (~221 MB).

### Fork delta: symlinks materialized as real files

This repo stores 60 paths as git symlinks (mode `120000`). Windows checks them out as **text stubs
containing the target path** unless `core.symlinks` is true, which requires Developer Mode or an
elevated shell — `git checkout` fails with `unable to create symlink: Permission denied` on this
machine.

Symptom: `bun run typecheck` in `packages/app` fails with two parse errors in
`src/custom-elements.d.ts`, a file nobody edited. Its entire content is the literal text
`../../ui/src/custom-elements.d.ts`.

The 14 stubs under `packages/app/` were replaced with real copies of their targets — the
`custom-elements.d.ts` type reference plus the favicon, manifest and social-share assets. Those
assets are all replaced during branding anyway, so materializing them costs the fork nothing.

`packages/enterprise/src/custom-elements.d.ts` was materialized too, for a different reason: the
**`pre-push` hook runs `bun typecheck`, which is `turbo typecheck` across all 30 packages**, not
just the ones we build. "We do not build that package" stops being true the moment you push, and
the failure arrives at the least convenient time — after the commit, with the same two parse errors
in a file nobody edited. If a future stub blocks a push, this is why.

The rest (assets under `packages/console`, `packages/enterprise`, `packages/web`, `sdks/vscode` and
`packages/docs`) are left alone — typecheck does not read them. Materialize them the same way if
that changes:

```bash
for f in $(git ls-files -s | awk '$1=="120000"{print $4}' | grep '^packages/app/'); do
  target=$(cat "$f"); src="$(dirname "$f")/$target"
  [ -e "$src" ] && cp "$src" "$f.tmp" && mv "$f.tmp" "$f"
done
```

## Running

**Verified working.**

```bash
bun run dev:desktop   # bun --cwd packages/desktop dev  -> electron-vite dev
bun run dev:web       # packages/app alone in a browser
```

`dev:desktop` runs `scripts/predev.ts` first (copies dev icons, then builds `packages/cli` for the
host target and stages it as `resources/jollicode-cli` — the v2 background daemon, only used when
`OPENCODE_SIDECAR_V2=1`; the default v1 sidecar is built from `packages/opencode`, see
`packages/desktop/src/main/server.ts` and `sidecar.ts`). It then builds the main and preload bundles
and serves the renderer at `http://localhost:5173/`.

First run compiles the CLI and downloads a models.dev snapshot (cached at
`~/.cache/jollicode/models.json`), so it is slower than later ones.

### Dev chrome is opt-in in this fork

Upstream shows a blue `DEV` chip in the titlebar and a performance bar (`FPS / JANK / CLS / MEM …`)
along the bottom whenever `import.meta.env.DEV` is set. Both are off here, because this build gets
shown to people who do not know what CLS is. To get them back:

```bash
VITE_JOLLI_DEBUG=1 bun run dev:desktop
```

Gated in `packages/app/src/pages/layout-new.tsx` (`DEBUG_CHROME`) and
`packages/app/src/components/titlebar.tsx` (`ChannelIndicator`). Note the two are **a pair**: the
chip was the toggle for the bar, so re-enabling one without the other leaves either an orphaned chip
or an unreachable bar.

## Seeing the UI without Electron

The Electron renderer cannot run in a plain browser — it needs the preload bridge, and
`webview-zoom.ts` throws on `onZoomFactorChanged` without it. But `packages/app` runs standalone
against any Jolli Code server, which is enough to review most screens (and to screenshot them):

```bash
bun run --cwd packages/opencode src/index.ts serve --port 4096   # a server to talk to
bun run dev:web                                                  # app on http://localhost:3000
```

Without the server on 4096 the shell renders but Home stays empty — connection refused, no projects,
no sessions. With it, the real Home renders.

⚠ **Do not pipe `bun run dev:*` through `Select-Object -First N` in PowerShell.** The pipeline stops
the upstream process once it has N objects, which kills the dev server a few seconds after it starts
and reports exit 255 with no error. Let it stream to the task output file instead.

Reviewing a real screen needs a project registered, and the picker's "Add project" dialog is served
by the server on 4096 — type a fragment of the path, then pick the row. Once one project exists, the
top-left **New session** button reaches the composer, which is where the course row, the privacy
control and the visibility line live.

## Tests

```bash
bun run --cwd packages/app test        # 724 unit + 41 browser
```

⚠ **Run it through `bun run`, never as a bare `bun test`.** The unit script passes
`--conditions=solid --preload ./happydom.ts`; without those, ~9 tests fail with
`SyntaxError: Export named 'use' not found in module solid-js/web/dist/server.js`, which looks like
a real regression and is not one.

## Gotcha: `createResource` anywhere in a session suspends the WHOLE session

`pages/session.tsx` wraps the route in `<Suspense>`, and a reading resource suspends its **nearest
boundary**, not its own subtree. So a `createResource` added deep inside the transcript — for us, one
line in a coaching badge — puts the entire session on that fallback and rebuilds it when it reads.

Symptom, and note that neither half points at the cause: the transcript loses its scroll position
(ours jumped ~228px to the top on the first hover of a badge) and the composer's **model chip
flashes** as it remounts. Two unrelated-looking artifacts, one primitive, nowhere near either.

It is invisible to every obvious check. Nothing calls `scrollTo`, `scrollTop`, `scrollIntoView` or
`focus`; `scrollHeight` and `clientHeight` never change; no `scroll` event fires; the scroll
container is the same element and stays connected. The scroll position is simply gone, because the
content under it was torn down and rebuilt. Hooking all six scroll APIs and finding an empty log is
how you know to stop looking at scrolling.

⚠ **Only the first interaction shows it**, because the resource then has a value. Re-testing without
a reload reproduces nothing and reads as fixed.

Use a signal plus an effect for anything async on this route (`timeline/coach-nudge.tsx` carries the
pattern): start with the value you can compute synchronously, replace it when the slow thing
resolves. `<Suspense>` boundaries are for route-level loads, and nothing inside a rendered transcript
should ever ask one to wait.

## Gotcha: `MenuV2.GroupLabel` needs a group around it

Kobalte's `GroupLabel` reads a group context, so a label placed as a direct child of
`MenuV2.Content` type-checks, renders nothing at build time, and then throws
`useMenuGroupContext must be used within a Menu.Group` the moment a user opens the menu.

Wrap items in `MenuV2.Group` (as `prompt-workspace-selector.tsx` does), or put the label **inside**
a `MenuV2.RadioGroup`, which renders a `Menu.Group` internally. For a line that labels nothing — a
footnote under a separator — use a plain `<div>`: the group-label slot is a fixed 28px single row
and will clip a sentence.

## Typecheck

```bash
bun run --cwd packages/app typecheck   # tsgo -b
```

Requires the symlink fix above, or it fails on `src/custom-elements.d.ts`.

## The models: one provider, declared as server config

This fork connects exactly one provider. `packages/core/src/jolli/gateway-config.ts` declares its
shape and `createSidecarEnv()` hands it to the server as `JOLLICODE_CONFIG_CONTENT`, which is the
strongest config layer. `enabled_providers: ["jolli"]` is what removes everything else, at the
source, before any screen reads a list.

The models in it are the **tenant's own catalogue**, fetched from `/api/agent/models` — the 34-model
mock list is gone. They are keyed by Registry UUID rather than by name, because names are not unique
across vendors and that block is an object keyed by id; the wire name rides along as each model's
`id` override.

An assistant's `allowedModelIds` then narrows within that: `jolli/<uuid>`, which needs no
translation because a course grants by the same UUID. Enforced in `context/models.tsx` (the list)
and `context/local.tsx`'s `validModel` (the selection) — and refused for real by the gateway.

⚠ **A server you start by hand has none of this.** `bun run dev:web` against a plain
`jollicode serve` will show whatever that machine has connected. Give the server the student's
credential instead and let it fetch its own catalogue — the config is no longer something you can
bake in one line, because the model list now comes from the gateway.

⚠ **These two variables are a development affordance and nothing else.** The credential lives in the
shared database (`jolli_credential`), written by whichever surface the student signed in on, and
`packages/core/src/jolli/session.ts` reads it from there. The env override exists so you can point a
hand-started server at a real account without signing in; it outranks the database when set, which
is exactly why `createSidecarEnv()` scrubs both spellings before forking the desktop's sidecar. That
scrub is permanent, not transitional: without it an inherited `JOLLICODE_JOLLI_TOKEN` from a login
shell would decide which account the app acts as.

```bash
JOLLICODE_JOLLI_TOKEN="<CLI JWT>" JOLLICODE_JOLLI_BASE_URL="<tenant base url>" \
  bun run --cwd packages/opencode src/index.ts serve --port 4096
```

Check what it ended up with:

```bash
# Only requiresCoding courses the viewer is actually in. Drafts and ended courses are HERE,
# carrying `entryState` — the picker greys them and says why.
curl -s http://127.0.0.1:4096/jolli/course | jq '.courses[] | {code, status, entryState}'
# One provider, and its models are keyed by Registry UUID.
curl -s http://127.0.0.1:4096/provider | jq 'keys'
curl -s http://127.0.0.1:4096/provider | jq '.jolli.models | keys | length'
```

## Gotcha: a project whose providers have not loaded shows "Select model"

The composer resolves its model through the **directory-scoped** provider list, while the picker
reads the global one. A project whose store failed to load therefore shows an empty "Select model"
chip and a picker full of models. Not a lockdown bug — open a project that loads cleanly.

## Gotcha: the model selection chain exists twice

`context/local.tsx` resolves the model for a **live session**; `pages/session/composer/prompt-model-selection.ts`
resolves it for the **new-session composer**. They are parallel implementations of the same
"saved pick → agent → configured → recent → provider default" chain, and upstream keeps both.

Every rule about what a course allows has to be written in both or it applies on one screen and not
the other — and the one it would miss is the new-session screen, where the course is chosen. Both
now check the grant (`isModelAllowed`) and both put the assistant's `modelId` ahead of the recent
list.

Both also had the same latent bug once a grant existed: the provider-default step tried only each
provider's _first_ model, which under a whitelist is usually not allowed, leaving the composer with
no model at all. Both now scan the provider's models.

## The TUI has courses too, and shares its answers rather than its code

`packages/tui` is no longer course-blind. It picks a course and an assistant through `/course` and
`/assistant` (`src/context/jolli.tsx`, `component/dialog-course.tsx`, `component/dialog-assistant.tsx`),
writes the binding into `metadata.jolli` as the session is created, and narrows its model picker to
the assistant's grant.

Everything that **decides** something lives in `packages/core/src/jolli/` and is called from both
renderers — `lookup.ts` (which assistants a course has, whether it can be started, what a grant
permits, why a course is greyed), `sharing.ts` (who reads a new session) and `binding.ts` (reading a
binding back off a session). A student must not get two answers depending on which surface they
opened, and the header of each file says so.

Three things differ on purpose:

- **The TUI offers no visibility switches.** It seeds a new session's readers from the course policy
  via `defaultSessionSharing` so the metadata shape matches, and stops there. The desktop app owns
  that control.
- **A course is mandatory before the first prompt**, under lockdown only, and only for a session
  being *created* — see `submissionBlocker`. A session that already ran unbound stays usable,
  because the server refuses to bind a course after the first message and refusing to prompt in one
  would brick every transcript written before this existed.
- **`/agents` and `/assistant` are different commands.** An agent is Jolli Code's build-or-plan; an
  assistant is the professor's, and it decides the instructions, guardrails and model grant.

⚠ **A context must not expose a field called `ready`.** `createSimpleContext` in the TUI gates its
children on `init.ready`, so a context reporting `ready: false` renders nothing below it — a
catalogue still in flight would blank the whole terminal. `JolliProvider` calls its flag `loaded`.

⚠ **The grant is keyed by the map KEY, not by `info.id`.** The key in `provider.models` is the
Registry UUID a course grants by. In the config the Jolli provider writes, the value's `id` is the
**upstream name** (`claude-opus-4-5`) — check it yourself with `curl -s localhost:4096/config`. They
happen to agree by the time a client reads `/provider`, because `provider/provider.ts` overwrites
each model's `id` with its key on the way out. Key on the grant's own vocabulary anyway; comparing a
grant against a vendor name drops everything.

## Branding: one source for the artwork, and how the icons were made

`packages/ui/src/components/jolli-brand.tsx` is the only file that draws the logo — `JolliMark`
(the node graph), `JolliLogo` (mark + "jolli"), and the two bodies as raw geometry. `logo.tsx` and
`v2/components/wordmark-v2.tsx` are thin re-skins over it, so surfaces this fork has never opened
(the launch splash, the error page, two empty-state watermarks) rebranded without being edited.

The fills are inlined rather than kept as the downloaded assets' `.cls-1` … `.cls-7` `<style>`
block: those class names are global the moment the SVG is inlined into a page.

The new-session hero sets **"Code" as `<text>` inside the logo's own SVG**, not as a sibling HTML
element — one coordinate system means the baseline and the scale factor line up by construction.
`font-size` is derived from the logotype's **x-height**, not its cap-height, so "ode" sits exactly
on "olli" and the "C" lands just under the ascenders; the component comment carries the arithmetic.
If the app's font or the word changes, re-derive that number and re-measure the `viewBox` width,
which is the text's advance — they are a pair.

⚠ **`OpenCode Zen` is the one brand string left in the locale files, deliberately** — it names a
third party's product. A blanket `s/OpenCode/Jolli Code/` will corrupt it.

### Regenerating the icons

`sharp` is in the bun store but is not a dependency of any workspace, so import it by path. The
`.ico` is assembled by hand as PNG-in-ICO (Vista+), which is what Electron and electron-builder
both read:

```bash
bun -e 'import sharp from "./node_modules/.bun/sharp@0.33.5/node_modules/sharp/lib/index.js"; console.log(sharp.versions)'
```

The square source is the mark on transparent, centred in a 1024 box; the full script that writes
`packages/desktop/icons/{dev,beta,prod}`, `packages/desktop/resources/icons`, `packages/app/public`
and `packages/ui/src/assets/favicon` lived in the session that made them — the shape is
`sharp(svg, {density: 512}).resize(n, n, {fit: "contain", background: transparent}).png()`, plus a
6-byte ICONDIR and one 16-byte ICONDIRENTRY per size.

`predev` copies `packages/desktop/icons/<channel>` → `resources/icons` on every `dev:desktop`, so
the channel directory is the one to edit; `resources/icons` is a build artifact.

macOS `.icns` files are **still upstream's** — nothing on this machine can build one.
