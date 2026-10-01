<p align="center">
  <a href="https://jolli.ai">
    <picture>
      <source srcset="packages/identity/jolli-logo-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/identity/jolli-logo-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/identity/jolli-logo-light.svg" alt="Jolli Code logo">
    </picture>
  </a>
</p>
<p align="center">Agent kodujący AI Jolli.</p>
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

### Instalacja

```bash
npm i -g @jolli.ai/jollicode@latest # albo bun/pnpm/yarn
```

### Aplikacja desktopowa (BETA)

Jolli Code jest także dostępny jako aplikacja desktopowa. Pobierz ją bezpośrednio ze strony [releases](https://github.com/jolliai/jollicode-releases/releases).

| Platforma             | Pobieranie                         |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `jollicode-desktop-mac-arm64.dmg`  |
| macOS (Intel)         | `jollicode-desktop-mac-x64.dmg`    |

### Agents

Jolli Code zawiera dwóch wbudowanych agentów, między którymi możesz przełączać się klawiszem `Tab`.

- **build** - Domyślny agent z pełnym dostępem do pracy developerskiej
- **plan** - Agent tylko do odczytu do analizy i eksploracji kodu
  - Domyślnie odmawia edycji plików
  - Pyta o zgodę przed uruchomieniem komend bash
  - Idealny do poznawania nieznanych baz kodu lub planowania zmian

Dodatkowo jest subagent **general** do złożonych wyszukiwań i wieloetapowych zadań.
Jest używany wewnętrznie i można go wywołać w wiadomościach przez `@general`.

### Budowanie na Jolli Code

Jeśli pracujesz nad projektem związanym z Jolli Code i używasz "jollicode" jako części nazwy (na przykład "jollicode-dashboard" lub "jollicode-mobile"), dodaj proszę notatkę do swojego README, aby wyjaśnić, że projekt nie jest tworzony przez zespół Jolli Code i nie jest z nami w żaden sposób powiązany.
