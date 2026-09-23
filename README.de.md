<p align="center">
  <a href="https://jolli.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="Jolli Code logo">
    </picture>
  </a>
</p>
<p align="center">Der Open-Source KI-Coding-Agent.</p>
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

### Installation

```bash
# YOLO
curl -fsSL https://jolli.ai/install | bash

# Paketmanager
npm i -g @jolli.ai/jollicode@latest # oder bun/pnpm/yarn
brew install jolliai/tap/jollicode # macOS und Linux (empfohlen, immer aktuell)
paru -S jollicode-bin              # Arch Linux (Latest from AUR)
```

> [!TIP]
> Entferne Versionen älter als 0.1.x vor der Installation.

### Desktop-App (BETA)

Jolli Code ist auch als Desktop-Anwendung verfügbar. Lade sie direkt von der [Releases-Seite](https://github.com/jolliai/jollicode/releases) oder [jolli.ai/download](https://jolli.ai/download) herunter.

| Plattform             | Download                           |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `jollicode-desktop-mac-arm64.dmg`  |
| macOS (Intel)         | `jollicode-desktop-mac-x64.dmg`    |
| Windows               | `jollicode-desktop-win-x64.exe`    |
| Linux                 | `.deb`, `.rpm` oder AppImage       |

#### Installationsverzeichnis

Das Installationsskript installiert nach `$HOME/.jollicode/bin`.

### Agents

Jolli Code enthält zwei eingebaute Agents, zwischen denen du mit der `Tab`-Taste wechseln kannst.

- **build** - Standard-Agent mit vollem Zugriff für Entwicklungsarbeit
- **plan** - Nur-Lese-Agent für Analyse und Code-Exploration
  - Verweigert Datei-Edits standardmäßig
  - Fragt vor dem Ausführen von bash-Befehlen nach
  - Ideal zum Erkunden unbekannter Codebases oder zum Planen von Änderungen

Außerdem ist ein **general**-Subagent für komplexe Suchen und mehrstufige Aufgaben enthalten.
Dieser wird intern genutzt und kann in Nachrichten mit `@general` aufgerufen werden.

Mehr dazu unter [Agents](https://jolli.ai/docs/agents).

### Dokumentation

Mehr Infos zur Konfiguration von Jolli Code findest du in unseren [**Docs**](https://jolli.ai/docs).

### Beitragen

Wenn du zu Jolli Code beitragen möchtest, lies bitte unsere [Contributing Docs](./CONTRIBUTING.md), bevor du einen Pull Request einreichst.

### Auf Jolli Code aufbauen

Wenn du an einem Projekt arbeitest, das mit Jolli Code zusammenhängt und "jollicode" als Teil seines Namens verwendet (z.B. "jollicode-dashboard" oder "jollicode-mobile"), füge bitte einen Hinweis in deine README ein, dass es nicht vom OpenCode-Team gebaut wird und nicht in irgendeiner Weise mit uns verbunden ist.

