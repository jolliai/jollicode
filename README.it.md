<p align="center">
  <a href="https://jolli.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="Logo Jolli Code">
    </picture>
  </a>
</p>
<p align="center">L’agente di coding AI open source.</p>
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

### Installazione

```bash
# YOLO
curl -fsSL https://jolli.ai/install | bash

# Package manager
npm i -g @jolli.ai/jollicode@latest # oppure bun/pnpm/yarn
brew install jolliai/tap/jollicode # macOS e Linux (consigliato, sempre aggiornato)
paru -S jollicode-bin              # Arch Linux (Latest from AUR)
```

> [!TIP]
> Rimuovi le versioni precedenti alla 0.1.x prima di installare.

### App Desktop (BETA)

Jolli Code è disponibile anche come applicazione desktop. Puoi scaricarla direttamente dalla [pagina delle release](https://github.com/jolliai/jollicode-releases/releases) oppure da [jolli.ai/download](https://jolli.ai/download).

| Piattaforma           | Download                           |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `jollicode-desktop-mac-arm64.dmg`  |
| macOS (Intel)         | `jollicode-desktop-mac-x64.dmg`    |
| Windows               | `jollicode-desktop-win-x64.exe`    |
| Linux                 | `.deb`, `.rpm`, oppure AppImage    |

#### Directory di installazione

Lo script di installazione installa in `$HOME/.jollicode/bin`.

### Agenti

Jolli Code include due agenti integrati tra cui puoi passare usando il tasto `Tab`.

- **build** – Predefinito, agente con accesso completo per il lavoro di sviluppo
- **plan** – Agente in sola lettura per analisi ed esplorazione del codice
  - Nega le modifiche ai file per impostazione predefinita
  - Chiede il permesso prima di eseguire comandi bash
  - Ideale per esplorare codebase sconosciute o pianificare modifiche

È inoltre incluso un sotto-agente **general** per ricerche complesse e attività multi-step.
Viene utilizzato internamente e può essere invocato usando `@general` nei messaggi.

Scopri di più sugli [agenti](https://jolli.ai/docs/agents).

### Documentazione

Per maggiori informazioni su come configurare Jolli Code, [**consulta la nostra documentazione**](https://jolli.ai/docs).

### Costruire su Jolli Code

Se stai lavorando a un progetto correlato a Jolli Code e che utilizza “jollicode” come parte del nome (ad esempio “jollicode-dashboard” o “jollicode-mobile”), aggiungi una nota nel tuo README per chiarire che non è sviluppato dal team Jolli Code e che non è affiliato in alcun modo con noi.
