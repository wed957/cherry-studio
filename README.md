<div align="right" >
  <details>
    <summary >🌐 Language</summary>
    <div>
      <div align="right">
        <p><a href="https://openaitx.github.io/view.html?user=CherryHQ&project=cherry-studio&lang=en">English</a></p>
        <p><a href="https://openaitx.github.io/view.html?user=CherryHQ&project=cherry-studio&lang=zh-CN">简体中文</a></p>
        <p><a href="https://openaitx.github.io/view.html?user=CherryHQ&project=cherry-studio&lang=zh-TW">繁體中文</a></p>
        <p><a href="https://openaitx.github.io/view.html?user=CherryHQ&project=cherry-studio&lang=ja">日本語</a></p>
        <p><a href="https://openaitx.github.io/view.html?user=CherryHQ&project=cherry-studio&lang=ko">한국어</a></p>
        <p><a href="https://openaitx.github.io/view.html?user=CherryHQ&project=cherry-studio&lang=hi">हिन्दी</a></p>
        <p><a href="https://openaitx.github.io/view.html?user=CherryHQ&project=cherry-studio&lang=th">ไทย</a></p>
        <p><a href="https://openaitx.github.io/view.html?user=CherryHQ&project=cherry-studio&lang=fr">Français</a></p>
        <p><a href="https://openaitx.github.io/view.html?user=CherryHQ&project=cherry-studio&lang=de">Deutsch</a></p>
        <p><a href="https://openaitx.github.io/view.html?user=CherryHQ&project=cherry-studio&lang=es">Español</a></p>
        <p><a href="https://openaitx.github.io/view.html?user=CherryHQ&project=cherry-studio&lang=it">Italiano</a></p>
        <p><a href="https://openaitx.github.io/view.html?user=CherryHQ&project=cherry-studio&lang=ru">Русский</a></p>
        <p><a href="https://openaitx.github.io/view.html?user=CherryHQ&project=cherry-studio&lang=pt">Português</a></p>
        <p><a href="https://openaitx.github.io/view.html?user=CherryHQ&project=cherry-studio&lang=nl">Nederlands</a></p>
        <p><a href="https://openaitx.github.io/view.html?user=CherryHQ&project=cherry-studio&lang=pl">Polski</a></p>
        <p><a href="https://openaitx.github.io/view.html?user=CherryHQ&project=cherry-studio&lang=ar">العربية</a></p>
        <p><a href="https://openaitx.github.io/view.html?user=CherryHQ&project=cherry-studio&lang=fa">فارسی</a></p>
        <p><a href="https://openaitx.github.io/view.html?user=CherryHQ&project=cherry-studio&lang=tr">Türkçe</a></p>
        <p><a href="https://openaitx.github.io/view.html?user=CherryHQ&project=cherry-studio&lang=vi">Tiếng Việt</a></p>
        <p><a href="https://openaitx.github.io/view.html?user=CherryHQ&project=cherry-studio&lang=id">Bahasa Indonesia</a></p>
      </div>
    </div>
  </details>
</div>

<h1 align="center">
  <a href="https://github.com/CherryHQ/cherry-studio/releases">
    <img src="https://github.com/CherryHQ/cherry-studio/blob/main/build/icon.png?raw=true" width="150" height="150" alt="banner" /><br>
  </a>
</h1>

<p align="center">English | <a href="./docs/zh/README.md">中文</a> | <a href="https://docs.cherry-ai.com/docs/en-us">Documents</a> | <a href="./docs/en/guides/development.md">Development</a> | <a href="https://github.com/CherryHQ/cherry-studio/issues">Feedback</a><br></p>

<div align="center">

[![][github-release-shield]][github-release-link]
[![][github-nightly-shield]][github-nightly-link]
[![][github-contributors-shield]][github-contributors-link]
[![][license-shield]][license-link]
</div>

# 🍒 Cherry Studio

Cherry Studio is a desktop client that supports multiple LLM providers, available on Windows, Mac and Linux.

> This repository is an independently maintained, Windows-focused derivative of upstream Cherry Studio `v1.9.13`. It is not an official `v2.x` release. The repository maintains a controlled upstream synchronization and release workflow; see [CUSTOM_BUILD.md](./CUSTOM_BUILD.md) for operational, updater, and AGPL-3.0 details.

This is an open-source distribution under the GNU Affero General Public License v3.0 (AGPL-3.0-only). It contains no product analytics, crash telemetry uploads, automatic trace exporters, advertisements, sponsor prompts, or enterprise upsell UI. Developer trace data, when explicitly enabled, remains local to the device and is never sent to a remote service.

👏 Join [Telegram Group](https://t.me/CherryStudioAI)｜[Discord](https://discord.gg/wez8HtpxqQ) | [QQ Group(575014769)](https://qm.qq.com/q/lo0D4qVZKi)

## Derivative Scope and Changes

This derivative is intentionally scoped to the upstream `v1.9.13` codebase. Its primary functional change is a generalized context-count implementation for assistant settings:

- Context-count number fields accept any non-negative safe integer, including values greater than the legacy UI limit of `100`.
- `100` remains the only UI sentinel for unlimited history. Values greater than `100` are treated as real message limits; runtime handling maps the sentinel to `Number.MAX_SAFE_INTEGER`.
- Sliders keep their original visual range. When a saved value exceeds that range, only the slider position is clamped for display; the saved value is never overwritten.

The source-level change is maintained by [`scripts/context-count-patch.ts`](./scripts/context-count-patch.ts), an AST-based patcher that:

- identifies only trusted context-count controls and removes only their top-level `max` constraint;
- leaves unrelated numeric inputs and sliders unchanged;
- fails closed when component identity, module resolution, state binding, or source structure is ambiguous; and
- validates all targets before writing, preventing partial source updates.

The patch is deliberately version-scoped. It targets the upstream `v1.9.13` layout and refuses to modify the restructured `v2.x` source tree. Upstream `v2.x` already supports unrestricted positive integer input natively, so this patch must not be applied to `v2.x`.

The current implementation has been verified with the context-count contract check, 109 patcher tests, full type checking, and a complete Electron/Vite production build.

# 🌠 Screenshot

![](https://github.com/user-attachments/assets/36dddb2c-e0fb-4a5f-9411-91447bab6e18)

![](https://github.com/user-attachments/assets/f549e8a0-2385-40b4-b52b-2039e39f2930)

![](https://github.com/user-attachments/assets/58e0237c-4d36-40de-b428-53051d982026)

# 🌟 Key Features

1. **Diverse LLM Provider Support**:

- ☁️ Major LLM Cloud Services: OpenAI, Gemini, Anthropic, and more
- 🔗 AI Web Service Integration: Claude, Perplexity, [Poe](https://poe.com/), and others
- 💻 Local Model Support with Ollama, LM Studio

2. **AI Assistants & Conversations**:

- 📚 300+ Pre-configured AI Assistants
- 🤖 Custom Assistant Creation
- 💬 Multi-model Simultaneous Conversations

3. **Document & Data Processing**:

- 📄 Supports Text, Images, Office, PDF, and more
- ☁️ WebDAV File Management and Backup
- 📊 Mermaid Chart Visualization
- 💻 Code Syntax Highlighting

4. **Practical Tools Integration**:

- 🔍 Global Search Functionality
- 📝 Topic Management System
- 🔤 AI-powered Translation
- 🎯 Drag-and-drop Sorting
- 🔌 Mini Program Support
- ⚙️ MCP(Model Context Protocol) Server

5. **Enhanced User Experience**:

- 🖥️ Cross-platform Support for Windows, Mac, and Linux
- 📦 Ready to Use - No Environment Setup Required
- 🎨 Light/Dark Themes and Transparent Window
- 📝 Complete Markdown Rendering
- 🤲 Easy Content Sharing

# 📝 Roadmap

We're actively working on the following features and improvements:

1. 🎯 **Core Features**

- Selection Assistant with smart content selection enhancement
- Deep Research with advanced research capabilities
- Memory System with global context awareness
- Document Preprocessing with improved document handling
- MCP Marketplace for Model Context Protocol ecosystem

2. 🗂 **Knowledge Management**

- Notes and Collections
- Dynamic Canvas visualization
- OCR capabilities
- TTS (Text-to-Speech) support

3. 📱 **Platform Support**

- HarmonyOS Edition (PC)
- Android App (Phase 1)
- iOS App (Phase 1)
- Multi-Window support
- Window Pinning functionality
- Intel AI PC (Core Ultra) Support

4. 🔌 **Advanced Features**

- Plugin System
- ASR (Automatic Speech Recognition)
- Assistant and Topic Interaction Refactoring

Track our progress and contribute on our [project board](https://github.com/orgs/CherryHQ/projects/7).

Want to influence our roadmap? Join our [GitHub Discussions](https://github.com/CherryHQ/cherry-studio/discussions) to share your ideas and feedback!

# 🌈 Theme

- Theme Gallery: <https://cherrycss.com>
- Aero Theme: <https://github.com/hakadao/CherryStudio-Aero>
- PaperMaterial Theme: <https://github.com/rainoffallingstar/CherryStudio-PaperMaterial>
- Claude dynamic-style: <https://github.com/bjl101501/CherryStudio-Claudestyle-dynamic>
- Maple Neon Theme: <https://github.com/BoningtonChen/CherryStudio_themes>

Welcome PR for more themes

# 🤝 Contributing

We welcome contributions to Cherry Studio! Here are some ways you can contribute:

1. **Contribute Code**: Develop new features or optimize existing code.
2. **Fix Bugs**: Submit fixes for any bugs you find.
3. **Maintain Issues**: Help manage GitHub issues.
4. **Product Design**: Participate in design discussions.
5. **Write Documentation**: Improve user manuals and guides.
6. **Community Engagement**: Join discussions and help users.
7. **Promote Usage**: Spread the word about Cherry Studio.

Refer to the [Branching Strategy](docs/en/guides/branching-strategy.md) for contribution guidelines

## Getting Started

1. **Fork the Repository**: Fork and clone it to your local machine.
2. **Create a Branch**: For your changes.
3. **Submit Changes**: Commit and push your changes.
4. **Open a Pull Request**: Describe your changes and reasons.

For more detailed guidelines, please refer to our [Contributing Guide](CONTRIBUTING.md).

Thank you for your support and contributions!

# 🔗 Related Projects

- [new-api](https://github.com/QuantumNous/new-api): The next-generation LLM gateway and AI asset management system supports multiple languages.

- [one-api](https://github.com/songquanpeng/one-api): LLM API management and distribution system supporting mainstream models like OpenAI, Azure, and Anthropic. Features a unified API interface, suitable for key management and secondary distribution.

- [Poe](https://poe.com/): Poe gives you access to the best AI, all in one place. Explore GPT-5, Claude Opus 4.1, DeepSeek-R1, Veo 3, ElevenLabs, and millions of others.

- [ublacklist](https://github.com/iorate/ublacklist): Blocks specific sites from appearing in Google search results

# 🚀 Contributors

<a href="https://github.com/CherryHQ/cherry-studio/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=CherryHQ/cherry-studio" />
</a>
<br /><br />

# 📜 License

The Cherry Studio Community Edition is governed by the standard GNU Affero General Public License v3.0 (AGPL-3.0), available at https://www.gnu.org/licenses/agpl-3.0.html.

Use of the Cherry Studio Community Edition for commercial purposes is permitted, subject to full compliance with the terms and conditions of the AGPL-3.0 license.

<!-- Links & Images -->

<!-- Links & Images -->

[github-release-shield]: https://img.shields.io/github/v/release/CherryHQ/cherry-studio?logo=github
[github-release-link]: https://github.com/CherryHQ/cherry-studio/releases
[github-nightly-shield]: https://img.shields.io/github/actions/workflow/status/CherryHQ/cherry-studio/nightly-build.yml?label=nightly%20build&logo=github
[github-nightly-link]: https://github.com/CherryHQ/cherry-studio/actions/workflows/nightly-build.yml
[github-contributors-shield]: https://img.shields.io/github/contributors/CherryHQ/cherry-studio?logo=github
[github-contributors-link]: https://github.com/CherryHQ/cherry-studio/graphs/contributors

<!-- Links & Images -->

[license-shield]: https://img.shields.io/badge/License-AGPLv3-important.svg?logo=gnu
[license-link]: https://www.gnu.org/licenses/agpl-3.0
