<p align="center">
  <a href="https://jolli.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="Jolli Code logo">
    </picture>
  </a>
</p>
<p align="center">El agente de programación con IA de código abierto.</p>
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

### Instalación

```bash
# YOLO
curl -fsSL https://jolli.ai/install | bash

# Gestores de paquetes
npm i -g @jolli.ai/jollicode@latest # o bun/pnpm/yarn
brew install jolliai/tap/jollicode # macOS y Linux (recomendado, siempre al día)
paru -S jollicode-bin              # Arch Linux (Latest from AUR)
```

> [!TIP]
> Elimina versiones anteriores a 0.1.x antes de instalar.

### App de escritorio (BETA)

Jolli Code también está disponible como aplicación de escritorio. Descárgala directamente desde la [página de releases](https://github.com/jolliai/jollicode/releases) o desde [jolli.ai/download](https://jolli.ai/download).

| Plataforma            | Descarga                           |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `jollicode-desktop-mac-arm64.dmg`  |
| macOS (Intel)         | `jollicode-desktop-mac-x64.dmg`    |
| Windows               | `jollicode-desktop-win-x64.exe`    |
| Linux                 | `.deb`, `.rpm`, o AppImage         |

#### Directorio de instalación

El script de instalación instala en `$HOME/.jollicode/bin`.

### Agentes

Jolli Code incluye dos agentes integrados que puedes alternar con la tecla `Tab`.

- **build** - Por defecto, agente con acceso completo para tareas de desarrollo
- **plan** - Agente de solo lectura para análisis y exploración de código
  - Deniega ediciones de archivos por defecto
  - Pide permiso antes de ejecutar comandos bash
  - Ideal para explorar codebases desconocidas o planificar cambios

Además, incluye un subagente **general** para búsquedas complejas y tareas de varios pasos.
Se usa internamente y se puede invocar con `@general` en los mensajes.

Más información sobre [agentes](https://jolli.ai/docs/agents).

### Documentación

Para más información sobre cómo configurar Jolli Code, [**ve a nuestra documentación**](https://jolli.ai/docs).

### Contribuir

Si te interesa contribuir a Jolli Code, lee nuestras [docs de contribución](./CONTRIBUTING.md) antes de enviar un pull request.

### Proyectos basados en Jolli Code

Si estás trabajando en un proyecto basado en Jolli Code y usas "jollicode" como parte del nombre, por ejemplo, "jollicode-dashboard" u "jollicode-mobile", agrega una nota en tu README para aclarar que no está hecho por el equipo de Jolli Code y que no está afiliado con nosotros de ninguna manera.

