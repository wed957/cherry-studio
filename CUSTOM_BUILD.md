# wed957 私有 Windows 构建说明

本仓库是从 `CherryHQ/cherry-studio` 的稳定 `v1` 分支导入的独立仓库，目标是保留本地修复并只生成 Windows 构建。它不是 GitHub fork；`upstream-v1` 分支仅用于记录最近一次同步的上游提交。

## GitHub Actions

`Sync upstream v1`（`.github/workflows/sync-upstream.yml`）每天运行一次，也可以手动运行。同步采用候选事务，不会先改动 `main`：

1. 从可信的下游 `main` 安装依赖，并要求 checkout SHA 与本次 schedule/dispatch 的 `github.workflow_sha` 一致；合并前会把补丁器及已锁定安装的 TypeScript 复制到 `RUNNER_TEMP` 隔离运行，随后删除 workspace `node_modules`。读取上游明确公布的 `refs/heads/v1` SHA、精确抓取该 ref 并复核 SHA 后才执行合并；changed 路径在合并前移除 API token，候选若跟踪任何 `node_modules` 路径会立即失败，最终提交也只重新暂存已跟踪文件。因此旧 workflow 不会验证更新后的候选，候选提交无法用依赖遮蔽执行代码，带写权限的步骤也不会执行候选安装脚本。同步始终恢复本仓库的补丁器和两个 Windows workflow，并从 Git index 删除其余 workflow（包括 symlink 和 gitlink），最终只接受两个来自可信基线的 `100644` blob。
2. workflow 或补丁器冲突会恢复可信的下游版本；其他源码、配置或锁文件冲突会安全失败并列出文件，不会用上游版本覆盖本地修复。
3. 语义补丁成功应用并复核后，工作流只上传 `candidate.bundle` 和 `metadata.env`。独立的写权限 job 会校验文件白名单、完整 SHA、提交祖先关系以及 `main`/`upstream-v1` 当前指针，但不会执行候选树中的代码；上游 `v1` 必须从已跟踪提交快进，重写或回退历史会停止同步。通过后才以空期望 lease 推送唯一的 `automation/upstream-candidate-<run_id>-<run_attempt>` 临时分支，拒绝覆盖被其他 SHA 抢占的引用。
4. `Build Windows` 作为 reusable workflow 接收候选的完整 40 位 SHA，并与其他所有 Windows 发布共用一个全局 concurrency 锁；它在 `windows-2022` 上运行补丁契约、补丁器测试、全量单元测试和完整的非写式 `pnpm ci:basic-check`，再执行 `pnpm build:win`。测试脚本和构建完成后都会检查 tracked tree 必须保持干净。`dist` 和逐个资产必须位于 workspace 内且不能是 symlink、junction 或 reparse point；构建必须同时产出 x64/arm64 的 portable、setup 安装包及至少一个 `latest*.yml`。允许发布的文件会写入严格格式的 `SHA256SUMS.txt` 并保存为带 SHA 和 run 标识的 Actions artifact，后续每次下载都要求普通顶层文件、manifest 与 payload 精确覆盖、白名单和 `sha256sum --strict --check` 同时通过。
5. 构建通过后先创建不可变 `windows-<完整 SHA>` 的 draft Release。失败后重跑可以继续修复同一 draft；每次删除、上传资产或发布前都会重新查询并确认 release ID、tag、draft/prerelease 状态和 `target_commitish`，发布前还必须先创建并再次解析到预期提交的 immutable Git tag。资产集合、GitHub digest、下载结果和 SHA256 全部通过后才发布；已经发布的 immutable Release 永远不会被修改，只允许在验证前后重复确认身份、target 和 tag commit。只有 immutable 验证成功，才使用带 lease 的单次 `git push --atomic` 同时更新 `main` 和 `upstream-v1`，并在 rolling 发布前后继续复核两个分支；任一分支发生变化都会停止事务，必须重新同步。
6. 分支晋级后才刷新 `windows-latest`（手动构建可指定其他 tag）。滚动 tag 更新前会核对当前 `main`，并把旧 `windows-latest` tag 与 `main` 一起带入精确 lease 的 `git push --atomic`；随后立即复核两个 ref。资产发布一旦开始就不再把 tag 单独回滚到旧版本，因为 GitHub Release 元数据与资产无法同 tag 原子回滚；失败会明确保留当前新 tag 和已发布的 immutable 权威版本，由后续同步通过 `publish_only` 重新覆盖并验证 rolling 资产。全部成功后才以候选 SHA 的精确 lease 删除临时候选分支；若分支被并发移动则拒绝删除，其他失败也会保留该分支供诊断。

自动 `Sync upstream v1` 调用候选构建或恢复构建时不会传递 `MAIN_VITE_CHERRYAI_CLIENT_SECRET`、`MAIN_VITE_MINERU_API_KEY`、`RENDERER_VITE_AIHUBMIX_SECRET`、`RENDERER_VITE_PPIO_APP_SECRET`，因此自动候选始终是 secret-free 构建，避免未晋级候选读取仓库构建 secrets。直接推送 `main` 或手动触发 `Build Windows` 时仍保留原有可选 secret 注入行为。

两个 workflow 都会在执行入口通过 GitHub API 复核仓库必须恰好是私有独立仓库 `wed957/cherry-studio`，并要求 `private=true`、`fork=false`、`parent=null`、`source=null`。仓库被改为公开、转换为 fork，或 reusable workflow 被其他仓库调用时都会 fail-closed，不会继续同步或发布。

当上游 SHA 没有变化时，工作流仍会确认 `upstream-v1` 是 `main` 的祖先并执行上下文补丁契约检查，然后比较当前 `main`、`windows-<main SHA>`、`windows-latest` 两个 tag 的提交，以及两个 Release 的资产 name/digest。只有补丁契约和两层 Release 都健康时才真正跳过构建；immutable 健康但 rolling 漂移时，workflow 使用 `publish_only` 从已发布 immutable 下载并复核权威资产后修复 `windows-latest`；immutable 缺失或不健康时，对当前 `main` 执行完整测试与重建。恢复失败会让同步失败，并保持固定失败 Issue 为打开状态。

同步事务失败会创建、重新打开或更新固定 Issue `[automation] Upstream sync failure`，记录失败 run、上游和候选 SHA 以及诊断分支。下一次完整同步成功，或“上游未变化”检查成功后，工作流会自动关闭该 Issue。

`windows-<完整 SHA>` 命名空间全部保留给权威、不可变审计记录，手动 `release_tag` 不能以 `-` 开头，也不能占用任何 `windows-<40 位十六进制>` tag。`windows-latest` 是方便下载的滚动指针；GitHub 没有提供同时更新 Release 元数据和全部资产的原子 API，Git 对 no-op branch update 也可能不发送 main 命令，因此 rolling 使用 preflight、双 lease 和更新后复核约束竞态，而不是把它当作完整事务。若滚动 Release 更新中断，tag 可能已经指向新 SHA，资产也可能只完成部分覆盖；工作流不会用旧 tag 掩盖这种状态，应以已验证的 immutable Release 为准，重新运行同步让 `publish_only` 恢复，不能把短暂的 `windows-latest` 状态当作构建完整性的唯一证据。

私有 GitHub Release 的安装包和 `latest*.yml` 不能被匿名 `electron-updater` 读取。当前 Release 用于仓库成员下载和审计，不应直接把私有 Release URL 配给面向未认证用户的自动更新。若需要终端自动更新，应另外提供公开的 generic feed，或在发行版中关闭自动检查并使用受控下载入口。

## 上下文数量修复

源码中的 `scripts/context-count-patch.ts` 使用 TypeScript AST 遍历 renderer 源码，只删除绑定可信 canonical `contextCount` state 的数字输入组件顶层显式 `max` 属性；antd `Slider` 和其他数字输入框保持不变。每个 canonical state 必须在同一来源文件中恰好配对一个数字输入和一个绑定同一 setter 的 Slider，不能靠另一个页面的重复节点凑足全局数量。可信来源限定为 antd `InputNumber`/`Slider`、经 TypeScript 实际模块解析到固定实现的 `@renderer/components/EditableNumber`，以及来源可验证的 React `memo`/`forwardRef` 与 `styled-components`/`@emotion` `styled` 包装。条件、算术、clamp 等有损 value 变换，隐藏 `parser`/`onChange` 限幅，setter 在其他路径的派生写入，模块 shadow/paths 漂移和参数 alias 逃逸都会 fail-closed；`EditableNumber` 的内部 state、InputNumber 和回调转发也必须通过跨文件契约。局部函数 wrapper 若在定义内部声明 `max` 会安全失败，不会跨调用点改写其定义；未知组件、标识符 spread、其他可能通过 spread 传入 `max` 的情况、语法错误或目标数量变化也都会失败。所有目标验证通过后才写入，避免部分修改：

```powershell
corepack pnpm context-count:check
corepack pnpm context-count:apply
```

设置页可以手动输入任意非负安全整数。`100` 仍是“使用全部消息”的 UI 哨兵，实际过滤使用 `Number.MAX_SAFE_INTEGER`；Slider 超出视觉范围时只钳制显示，不改变已保存的数值。

## 验证与审计

本地修改补丁器或同步逻辑后，至少运行与 CI 一致的关键检查：

```powershell
corepack pnpm context-count:check
corepack pnpm exec vitest run scripts/context-count-patch.test.ts --silent
corepack pnpm exec vitest run --silent --project=main
corepack pnpm exec vitest run --silent --project=renderer --pool=forks --maxWorkers=2 --minWorkers=1
corepack pnpm exec vitest run --silent --project=aiCore
corepack pnpm exec vitest run --silent --project=shared --pool=forks
corepack pnpm exec vitest run --silent --project=scripts
corepack pnpm ci:basic-check
```

`pnpm build:win` 需要 Windows 构建环境，正式结果以 `Build Windows` workflow 的精确 SHA 构建为准。该 workflow 会自动验证 checkout SHA、四类必需安装包、资产白名单、远端 Release tag、GitHub 资产 digest 以及下载后的 `SHA256SUMS.txt`。

手动触发 `Sync upstream v1` 后，应在 Actions 摘要中确认 `Prepare`、`Stage` 和候选事务结果。若上游未变化，`Stage` 和 Windows 候选事务应显示为跳过，摘要应报告契约检查通过；若有更新，则核对 `main` 指向候选 SHA、`upstream-v1` 指向记录的上游 SHA，并确认同一候选 SHA 同时出现在 `windows-<完整 SHA>` 与 `windows-latest` 的 tag 和资产校验结果中。任何失败都应保持受保护分支不被半更新，并在固定失败 Issue 中留下可追踪信息。

## 已安装程序 Hook

原始 `C:\Users\Administrator\Desktop\cherry-context-hook` 是针对旧版已安装程序的独立工具，不参与源码构建；源码仓库已合并语义补丁，不依赖该目录继续存在。若仍保留旧工具并需要修补已安装版本，它使用固定版本 `@electron/asar@4.2.1`，会扫描所有 renderer chunk，保留 `asarUnpack` 元数据，写入前创建带源文件 SHA256 的备份，并通过临时归档和原子替换回滚失败操作。请先退出 Cherry Studio，再在工具目录执行：

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
