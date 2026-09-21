# Dev setup (Windows)

Verified 2026-09-09 on Windows 11, upstream `9f8db119`.

## Toolchain

| Tool | Status |
|---|---|
| Bun 1.4.2 | `C:\Users\<user>\.bun\bin\bun.exe` — required |
| gh | `C:\Program Files\GitHub CLI\gh.exe` — only for the fork remote |
| Go | **not needed** — the repo has zero `.go` files |
| Python / MSVC | **not needed** — see the tree-sitter note below |

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

Bun runs postinstall scripts only for *freshly installed* packages. If an earlier `bun install`
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

`dev:desktop` runs `scripts/predev.ts` first (copies dev icons, then downloads
`@opencode-ai/cli-windows-x64-baseline` into `resources/jollicode-cli.exe` — the sidecar server the
Electron app spawns, see `packages/desktop/src/main/server.ts` and `sidecar.ts`). It then builds the
main and preload bundles and serves the renderer at `http://localhost:5173/`.

First run downloads the CLI sidecar and a models.dev snapshot (cached at
`~/.cache/opencode/models.json`), so it is slower than later ones.

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
against any opencode server, which is enough to review most screens (and to screenshot them):

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

This fork connects exactly one provider. `packages/desktop/src/main/jolli-gateway.ts` declares it —
the web mock's 34-model catalogue (jolli-edu-design, `app/src/data/models.ts`) under a provider
called `jolli` — and `createSidecarEnv()` hands it to the server as `OPENCODE_CONFIG_CONTENT`, which
is the strongest config layer. `enabled_providers: ["jolli"]` is what removes everything else, at
the source, before any screen reads a list.

An assistant's `allowedModelIds` then narrows within that: `jolli/<model id>`, enforced in
`context/models.tsx` (the list) and `context/local.tsx`'s `validModel` (the selection).

⚠ **A server you start by hand has none of this.** `bun run dev:web` against a plain
`opencode serve` will show whatever that machine has connected. Pass the same config to review the
real thing:

```bash
bun -e 'import {jolliGatewayConfig} from "./packages/desktop/src/main/jolli-gateway.ts"; console.log(jolliGatewayConfig())' > /tmp/gateway.json
OPENCODE_CONFIG_CONTENT="$(cat /tmp/gateway.json)" bun run --cwd packages/opencode src/index.ts serve --port 4096
```

Check what the server ended up with:

```bash
curl -s http://127.0.0.1:4096/provider
```

⚠ **Every model is routed to a free OpenCode Zen model** (`ROUTE` in that file), because most of the
web mock's catalogue does not exist yet and a model with no route fails on send. Demo the controls,
not the answers.

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
provider's *first* model, which under a whitelist is usually not allowed, leaving the composer with
no model at all. Both now scan the provider's models.

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

⚠ **`ai.opencode.desktop*` is not a brand string.** `main/index.ts` sets `userData` to
`appData/<appId>`, so renaming the id moves the whole demo machine's state — projects, tabs,
settings. Same for `app = "opencode"` in `packages/core/src/global.ts`. Both are Phase 1 leftovers
on purpose.

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
