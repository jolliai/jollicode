<p align="center">
  <a href="https://jolli.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="Jolli Code logo">
    </picture>
  </a>
</p>
<p align="center">AI-kodeagent med åpen kildekode.</p>
<p align="center">
  <a href="https://www.npmjs.com/package/@jolli.ai/jollicode"><img alt="npm" src="https://img.shields.io/npm/v/@jolli.ai/jollicode?style=flat-square" /></a>
  <a href="https://github.com/jolliai/jollicode/actions/workflows/publish.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/jolliai/jollicode/publish.yml?style=flat-square&branch=dev" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a> |
  <a href="README.zht.md">繁體中文</a> |
  <a href="README.ko.md">한국어</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.es.md">Español</a> |
  <a href="README.fr.md">Français</a> |
  <a href="README.it.md">Italiano</a> |
  <a href="README.da.md">Dansk</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.pl.md">Polski</a> |
  <a href="README.ru.md">Русский</a> |
  <a href="README.bs.md">Bosanski</a> |
  <a href="README.ar.md">العربية</a> |
  <a href="README.no.md">Norsk</a> |
  <a href="README.br.md">Português (Brasil)</a> |
  <a href="README.th.md">ไทย</a> |
  <a href="README.tr.md">Türkçe</a> |
  <a href="README.uk.md">Українська</a> |
  <a href="README.bn.md">বাংলা</a> |
  <a href="README.gr.md">Ελληνικά</a> |
  <a href="README.vi.md">Tiếng Việt</a>
</p>

[![Jolli Code Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://jolli.ai)

---

### Installasjon

```bash
# YOLO
curl -fsSL https://jolli.ai/install | bash

# Pakkehåndterere
npm i -g @jolli.ai/jollicode@latest # eller bun/pnpm/yarn
brew install jolliai/tap/jollicode # macOS og Linux (anbefalt, alltid oppdatert)
paru -S jollicode-bin              # Arch Linux (Latest from AUR)
```

> [!TIP]
> Fjern versjoner eldre enn 0.1.x før du installerer.

### Desktop-app (BETA)

Jolli Code er også tilgjengelig som en desktop-app. Last ned direkte fra [releases-siden](https://github.com/jolliai/jollicode/releases) eller [jolli.ai/download](https://jolli.ai/download).

| Plattform             | Nedlasting                         |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `jollicode-desktop-mac-arm64.dmg`  |
| macOS (Intel)         | `jollicode-desktop-mac-x64.dmg`    |
| Windows               | `jollicode-desktop-win-x64.exe`    |
| Linux                 | `.deb`, `.rpm` eller AppImage      |

#### Installasjonsmappe

Installasjonsskriptet installerer til `$HOME/.jollicode/bin`.

### Agents

Jolli Code har to innebygde agents du kan bytte mellom med `Tab`-tasten.

- **build** - Standard, agent med full tilgang for utviklingsarbeid
- **plan** - Skrivebeskyttet agent for analyse og kodeutforsking
  - Nekter filendringer som standard
  - Spør om tillatelse før bash-kommandoer
  - Ideell for å utforske ukjente kodebaser eller planlegge endringer

Det finnes også en **general**-subagent for komplekse søk og flertrinnsoppgaver.
Den brukes internt og kan kalles via `@general` i meldinger.

Les mer om [agents](https://jolli.ai/docs/agents).

### Dokumentasjon

For mer info om hvordan du konfigurerer Jolli Code, [**se dokumentasjonen**](https://jolli.ai/docs).

### Bidra

Hvis du vil bidra til Jolli Code, les [contributing docs](./CONTRIBUTING.md) før du sender en pull request.

### Bygge på Jolli Code

Hvis du jobber med et prosjekt som er relatert til Jolli Code og bruker "jollicode" som en del av navnet; for eksempel "jollicode-dashboard" eller "jollicode-mobile", legg inn en merknad i README som presiserer at det ikke er bygget av OpenCode-teamet og ikke er tilknyttet oss på noen måte.

