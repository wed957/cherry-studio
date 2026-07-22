# wed957 私有 Windows 构建说明

本仓库是从 `CherryHQ/cherry-studio` 的稳定 `v1` 分支导入的独立仓库，目标是保留本地修复并只生成 Windows 构建。它不是 GitHub fork；`upstream-v1` 分支仅用于记录最近一次同步的上游提交。

## GitHub Actions

- `Sync upstream v1`（`.github/workflows/sync-upstream.yml`）每天运行一次，也可以手动运行。它合并 `upstream/v1`，删除上游带来的非 Windows workflow，重新应用上下文输入框补丁，并推送 `main`。
- 只有 workflow 文件冲突会自动保留本仓库版本。源码或锁文件冲突会失败并列出文件，必须先人工解决，避免同步过程覆盖本地修复。
- `Build Windows`（`.github/workflows/build-windows.yml`）在 `main` 更新后运行，使用 `.node-version` 和 `pnpm-lock.yaml`，在 `windows-2022` 上执行 `pnpm build:win`，同时生成 `SHA256SUMS.txt`。构建产物会保存为 Actions artifact，并更新私有仓库的 `windows-latest` 预发布 Release；手动运行时可填写其他 tag。
- `GITHUB_TOKEN` 推送不会自动触发另一个 workflow，因此同步 workflow 在推送完成后显式 dispatch Windows 构建。

私有 GitHub Release 的安装包和 `latest*.yml` 不能被匿名 `electron-updater` 读取。当前 Release 用于仓库成员下载和审计，不应直接把私有 Release URL 配给面向未认证用户的自动更新。若需要终端自动更新，应另外提供公开的 generic feed，或在发行版中关闭自动检查并使用受控下载入口。

## 上下文数量修复

源码中的 `scripts/context-count-patch.ts` 会遍历 renderer 源码，只删除带 `value={contextCount}` 的 `EditableNumber`/`InputNumber` 顶层 JSX `max` 属性；Slider 和其他数字输入框保持不变。脚本会忽略注释、字符串和嵌套表达式，并要求当前上游仍有两个目标组件：

```powershell
corepack pnpm context-count:check
corepack pnpm context-count:apply
```

设置页可以手动输入任意非负安全整数。`100` 仍是“使用全部消息”的 UI 哨兵，实际过滤使用 `Number.MAX_SAFE_INTEGER`；Slider 超出视觉范围时只钳制显示，不改变已保存的数值。

## 已安装程序 Hook

`C:\Users\Administrator\Desktop\cherry-context-hook` 是针对旧版已安装程序的独立工具，不参与源码构建。它使用固定版本 `@electron/asar@4.2.1`，会扫描所有 renderer chunk，保留 `asarUnpack` 元数据，写入前创建带源文件 SHA256 的备份，并通过临时归档和原子替换回滚失败操作。请先退出 Cherry Studio，再在工具目录执行：

```powershell
npm ci
node hook.js --scan
node hook.js --no-start
node hook.js --check
node hook.js --restore
```

需要修改 `Program Files` 安装目录时，请以管理员权限运行。`config.json` 可设置 `cherryStudioDir`、`contextCountMax` 和 `autoStart`；源码版本优先使用仓库内的补丁脚本。

## AGPL-3.0

Cherry Studio 及本仓库沿用 `AGPL-3.0`。分发修改后的安装包或提供网络服务时，应保留版权和许可证声明，并向用户提供对应源码及相同许可证下的修改内容。私有仓库不改变这些义务，也不授予上游商标或服务的额外权利。
