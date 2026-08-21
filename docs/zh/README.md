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
<p align="center">
  <a href="https://github.com/CherryHQ/cherry-studio">English</a> | 中文 | <a href="https://docs.cherry-ai.com">文档</a> | <a href="./guides/development.md">开发</a> | <a href="https://github.com/CherryHQ/cherry-studio/issues">反馈</a><br>
</p>

<div align="center">

[![][github-release-shield]][github-release-link]
[![][github-contributors-shield]][github-contributors-link]
[![][license-shield]][license-link]
</div>

# 🍒 Cherry Studio

Cherry Studio 是一款支持多个大语言模型（LLM）服务商的桌面客户端，兼容 Windows、Mac 和 Linux 系统。

> 本仓库是基于上游 Cherry Studio `v1.9.13` 独立维护、面向 Windows 的衍生版本，不是官方 `v2.x` 发布版。仓库维护受控的上游同步与发布流程；运行、自动更新和 AGPL-3.0 义务请参阅根目录的 [CUSTOM_BUILD.md](../../CUSTOM_BUILD.md)。

本发行版采用 GNU Affero General Public License v3.0（AGPL-3.0-only）开源，不包含产品分析、崩溃遥测上传、自动 trace 导出、广告、赞助引导或企业版导流界面。开发者 trace 数据仅在明确启用时保留在本地设备，不会发送到远端服务。

👏 欢迎加入 [Telegram 群组](https://t.me/CherryStudioAI)｜[Discord](https://discord.gg/wez8HtpxqQ) | [QQ群(575014769)](https://qm.qq.com/q/lo0D4qVZKi)

## 衍生版本范围与变更

本衍生版本有意基于上游 `v1.9.13` 维护，主要功能变更是扩展助手设置中的上下文数量：

- 上下文数量输入框接受任意非负安全整数，包括超过旧版界面上限 `100` 的数值。
- `100` 仍是唯一的“使用全部历史消息”界面哨兵值。大于 `100` 的数值按真实消息数量处理；运行时会将哨兵值转换为 `Number.MAX_SAFE_INTEGER`。
- Slider 保留原有的视觉范围。已保存数值超出该范围时，仅钳制 Slider 的显示位置，不会覆盖已保存的数值。

源码变更由 [`scripts/context-count-patch.ts`](../../scripts/context-count-patch.ts) 维护。该补丁器基于 AST 语义分析：

- 只识别可信的上下文数量控件，并删除其顶层 `max` 限制；
- 保持其他数字输入框和 Slider 不变；
- 当组件身份、模块解析、状态绑定或源码结构存在歧义时 fail-closed，拒绝修改；
- 所有目标验证通过后才写入，避免部分修改。

补丁明确限定在上游 `v1.9.13` 的源码结构中，并会拒绝修改已经重构的 `v2.x` 源码。上游 `v2.x` 已原生支持不设上限的正整数输入，因此不要将本补丁应用到 `v2.x`。

当前实现已通过上下文数量契约检查、109 项补丁器测试、完整类型检查和 Electron/Vite 生产构建。

# 📖 使用教程

https://docs.cherry-ai.com

# 🌠 界面

![](https://github.com/user-attachments/assets/36dddb2c-e0fb-4a5f-9411-91447bab6e18)

![](https://github.com/user-attachments/assets/f549e8a0-2385-40b4-b52b-2039e39f2930)

![](https://github.com/user-attachments/assets/58e0237c-4d36-40de-b428-53051d982026)

# 🌟 主要特性

1. **多样化 LLM 服务支持**：

- ☁️ 支持主流 LLM 云服务：OpenAI、Gemini、Anthropic、硅基流动等
- 🔗 集成流行 AI Web 服务：Claude、Perplexity、Poe、腾讯元宝、知乎直答等
- 💻 支持 Ollama、LM Studio 本地模型部署

2. **智能助手与对话**：

- 📚 内置 300+ 预配置 AI 助手
- 🤖 支持自定义创建专属助手
- 💬 多模型同时对话，获得多样化观点

3. **文档与数据处理**：

- 📄 支持文本、图片、Office、PDF 等多种格式
- ☁️ WebDAV 文件管理与数据备份
- 📊 Mermaid 图表可视化
- 💻 代码高亮显示

4. **实用工具集成**：

- 🔍 全局搜索功能
- 📝 话题管理系统
- 🔤 AI 驱动的翻译功能
- 🎯 拖拽排序
- 🔌 小程序支持
- ⚙️ MCP(模型上下文协议) 服务

5. **优质使用体验**：

- 🖥️ Windows、Mac、Linux 跨平台支持
- 📦 开箱即用，无需配置环境
- 🎨 支持明暗主题与透明窗口
- 📝 完整的 Markdown 渲染
- 🤲 便捷的内容分享功能

# 📝 开发计划

我们正在积极开发以下功能和改进：

1. 🎯 **核心功能**

- 选择助手 - 智能内容选择增强
- 深度研究 - 高级研究能力
- 全局记忆 - 全局上下文感知
- 文档预处理 - 改进文档处理能力
- MCP 市场 - 模型上下文协议生态系统

2. 🗂 **知识管理**

- 笔记与收藏功能
- 动态画布可视化
- OCR 光学字符识别
- TTS 文本转语音支持

3. 📱 **平台支持**

- 鸿蒙版本 (PC)
- Android 应用（第一期）
- iOS 应用（第一期）
- 多窗口支持
- 窗口置顶功能

4. 🔌 **高级特性**

- 插件系统
- ASR 语音识别
- 助手与话题交互重构

在我们的[项目面板](https://github.com/orgs/CherryHQ/projects/7)上跟踪进展并参与贡献。

想要影响开发计划？欢迎加入我们的 [GitHub 讨论区](https://github.com/CherryHQ/cherry-studio/discussions) 分享您的想法和反馈！

# 🌈 主题

- 主题库：https://cherrycss.com
- Aero 主题：https://github.com/hakadao/CherryStudio-Aero
- PaperMaterial 主题：https://github.com/rainoffallingstar/CherryStudio-PaperMaterial
- 仿 Claude 主题：https://github.com/bjl101501/CherryStudio-Claudestyle-dynamic
- 霓虹枫叶主题：https://github.com/BoningtonChen/CherryStudio_themes

欢迎 PR 更多主题

# 🤝 贡献

我们欢迎对 Cherry Studio 的贡献！您可以通过以下方式贡献：

1. **贡献代码**：开发新功能或优化现有代码
2. **修复错误**：提交您发现的错误修复
3. **维护问题**：帮助管理 GitHub 问题
4. **产品设计**：参与设计讨论
5. **撰写文档**：改进用户手册和指南
6. **社区参与**：加入讨论并帮助用户
7. **推广使用**：宣传 Cherry Studio

参考[分支策略](./guides/branching-strategy.md)了解贡献指南

## 入门

1. **Fork 仓库**：Fork 并克隆到您的本地机器
2. **创建分支**：为您的更改创建分支
3. **提交更改**：提交并推送您的更改
4. **打开 Pull Request**：描述您的更改和原因

有关更详细的指南，请参阅我们的 [贡献指南](./guides/contributing.md)

感谢您的支持和贡献！

# 🔗 相关项目

- [one-api](https://github.com/songquanpeng/one-api)：LLM API 管理及分发系统，支持 OpenAI、Azure、Anthropic 等主流模型，统一 API 接口，可用于密钥管理与二次分发。

- [ublacklist](https://github.com/iorate/ublacklist)：屏蔽特定网站在 Google 搜索结果中显示

# 🚀 贡献者

<a href="https://github.com/CherryHQ/cherry-studio/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=CherryHQ/cherry-studio" />
</a>
<br /><br />

<!-- Links & Images -->

[github-release-shield]: https://img.shields.io/github/v/release/CherryHQ/cherry-studio
[github-release-link]: https://github.com/CherryHQ/cherry-studio/releases
[github-contributors-shield]: https://img.shields.io/github/contributors/CherryHQ/cherry-studio
[github-contributors-link]: https://github.com/CherryHQ/cherry-studio/graphs/contributors

[license-shield]: https://img.shields.io/badge/License-AGPLv3-important.svg?logo=gnu
[license-link]: https://www.gnu.org/licenses/agpl-3.0
