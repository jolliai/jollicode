<p align="center">
  <a href="https://jolli.ai">
    <picture>
      <source srcset="packages/identity/jolli-logo-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/identity/jolli-logo-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/identity/jolli-logo-light.svg" alt="Jolli Code logo">
    </picture>
  </a>
</p>
<p align="center">Jolli AI-kodeagenten.</p>
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

---

### Installation

```bash
npm i -g @jolli.ai/jollicode@latest # eller bun/pnpm/yarn
```

### Desktop-app (BETA)

Jolli Code findes også som desktop-app. Download direkte fra [releases-siden](https://github.com/jolliai/jollicode-releases/releases).

| Platform              | Download                           |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `jollicode-desktop-mac-arm64.dmg`  |
| macOS (Intel)         | `jollicode-desktop-mac-x64.dmg`    |

### Agents

Jolli Code har to indbyggede agents, som du kan skifte mellem med `Tab`-tasten.

- **build** - Standard, agent med fuld adgang til udviklingsarbejde
- **plan** - Skrivebeskyttet agent til analyse og kodeudforskning
  - Afviser filredigering som standard
  - Spørger om tilladelse før bash-kommandoer
  - Ideel til at udforske ukendte kodebaser eller planlægge ændringer

Derudover findes der en **general**-subagent til komplekse søgninger og flertrinsopgaver.
Den bruges internt og kan kaldes via `@general` i beskeder.

### Bygget på Jolli Code

Hvis du arbejder på et projekt der er relateret til Jolli Code og bruger "jollicode" som en del af navnet; f.eks. "jollicode-dashboard" eller "jollicode-mobile", så tilføj en note i din README, der tydeliggør at projektet ikke er bygget af Jolli Code-teamet og ikke er tilknyttet os på nogen måde.
