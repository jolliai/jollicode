<p align="center">
  <a href="https://jolli.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="Logo Jolli Code">
    </picture>
  </a>
</p>
<p align="center">L'agent de codage IA open source.</p>
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

# Gestionnaires de paquets
npm i -g @jolli.ai/jollicode@latest # ou bun/pnpm/yarn
brew install jolliai/tap/jollicode # macOS et Linux (recommandé, toujours à jour)
paru -S jollicode-bin              # Arch Linux (Latest from AUR)
```

> [!TIP]
> Supprimez les versions antérieures à 0.1.x avant d'installer.

### Application de bureau (BETA)

Jolli Code est aussi disponible en application de bureau. Téléchargez-la directement depuis la [page des releases](https://github.com/jolliai/jollicode-releases/releases) ou [jolli.ai/download](https://jolli.ai/download).

| Plateforme            | Téléchargement                     |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `jollicode-desktop-mac-arm64.dmg`  |
| macOS (Intel)         | `jollicode-desktop-mac-x64.dmg`    |
| Windows               | `jollicode-desktop-win-x64.exe`    |
| Linux                 | `.deb`, `.rpm`, ou AppImage        |

#### Répertoire d'installation

Le script d'installation installe dans `$HOME/.jollicode/bin`.

### Agents

Jolli Code inclut deux agents intégrés que vous pouvez basculer avec la touche `Tab`.

- **build** - Par défaut, agent avec accès complet pour le travail de développement
- **plan** - Agent en lecture seule pour l'analyse et l'exploration du code
  - Refuse les modifications de fichiers par défaut
  - Demande l'autorisation avant d'exécuter des commandes bash
  - Idéal pour explorer une base de code inconnue ou planifier des changements

Un sous-agent **general** est aussi inclus pour les recherches complexes et les tâches en plusieurs étapes.
Il est utilisé en interne et peut être invoqué via `@general` dans les messages.

En savoir plus sur les [agents](https://jolli.ai/docs/agents).

### Documentation

Pour plus d'informations sur la configuration d'Jolli Code, [**consultez notre documentation**](https://jolli.ai/docs).

### Construire avec Jolli Code

Si vous travaillez sur un projet lié à Jolli Code et que vous utilisez "jollicode" dans le nom du projet (par exemple, "jollicode-dashboard" ou "jollicode-mobile"), ajoutez une note dans votre README pour préciser qu'il n'est pas construit par l'équipe Jolli Code et qu'il n'est pas affilié à nous.
