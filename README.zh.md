<p align="center">
  <a href="https://jolli.ai">
    <picture>
      <source srcset="packages/identity/jolli-logo-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/identity/jolli-logo-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/identity/jolli-logo-light.svg" alt="Jolli Code logo">
    </picture>
  </a>
</p>
<p align="center">Jolli 的 AI Coding Agent。</p>
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

### 安装

```bash
npm i -g @jolli.ai/jollicode@latest # 也可使用 bun/pnpm/yarn
```

### 桌面应用程序 (BETA)

Jolli Code 也提供桌面版应用。可直接从 [发布页 (releases page)](https://github.com/jolliai/jollicode-releases/releases) 下载。

| 平台                    | 下载文件                               |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `jollicode-desktop-mac-arm64.dmg`  |
| macOS (Intel)         | `jollicode-desktop-mac-x64.dmg`    |

### Agents

Jolli Code 内置两种 Agent，可用 `Tab` 键快速切换：

- **build** - 默认模式，具备完整权限，适合开发工作
- **plan** - 只读模式，适合代码分析与探索
  - 默认拒绝修改文件
  - 运行 bash 命令前会询问
  - 便于探索未知代码库或规划改动

另外还包含一个 **general** 子 Agent，用于复杂搜索和多步任务，内部使用，也可在消息中输入 `@general` 调用。

### 基于 Jolli Code 进行开发

如果你在项目名中使用了 “jollicode”（如 “jollicode-dashboard” 或 “jollicode-mobile”），请在 README 里注明该项目不是 Jolli Code 团队官方开发，且不存在隶属关系。
