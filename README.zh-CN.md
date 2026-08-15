# DSH Release Guardian

[English](./README.md) · [架构](./docs/architecture.md) · [安全模型](./docs/security-model.md) · [故障排查](./docs/troubleshooting.md)

面向 Git 变更的本地、确定性发布风险检查器。它读取变更文件与新增代码，识别凭据泄露、危险 CI 配置、发布配置变更和高风险执行方式，并发现项目已有的测试、类型检查与构建命令。

Release Guardian 是风险信号，不是“发布一定安全”的证明。`ready` 只表示：在本次已完成、已配置的扫描范围内，没有发现阻断发布的条件。

## 四种入口

| 入口 | 适用场景 | 说明 |
| --- | --- | --- |
| **DSH bundle** | DeepSeek Harness profile 与工具调用 | 安装包后注册 `release_guardian_check`。 |
| **独立 CLI** | 终端、本地脚本与 CI | 使用 `dsh-release-guardian` 命令。 |
| **Codex 适配器（可选）** | 在 Codex 中进行引导式审计 | 加载 `release-guardian` skill，通过包内 runner 调用同一检查器。 |
| **Claude Code 插件（可选）** | 在 Claude Code 中进行引导式审计与可选的提交前拦截 | 加载 `.claude-plugin/plugin.json`，把 `dsh-release-guardian` 放入会话 `PATH`，并复用同一个 skill。 |

四种入口共享同一套扫描核心、规则、报告 schema 和执行授权边界。组件关系见[架构文档](./docs/architecture.md)。

## 安全边界

默认 `check` 对目标仓库只读：会运行本地 Git 命令并读取配置和 manifest，但不会执行项目代码。工具无遥测，不会安装项目依赖、发布软件包或部署应用。

执行项目检查是独立且必须明确授权的操作：

- CLI 只有在传入 `--run-checks` 后才会执行；交互模式会展示精确命令并确认，非交互模式还需要 `--yes`。
- DSH 工具只有在 `action: "run"` 且携带上一次发现结果中的精确命令 ID 时才会执行。
- 已批准的命令**不在沙箱中运行**，拥有当前用户在目标仓库中的权限。
- 离线、禁止 restore、只读依赖等参数，以及缩减后的环境变量，都只是尽力而为的防护，不是网络或文件系统安全边界。
- 只有完整的 `worktree` 扫描（包含未跟踪文件）可以进入执行阶段；源文件或配置变化会使旧授权失效。
- `.release-guardian.yml` 中的自定义 argv 只会加入待展示计划，配置本身永远不等于执行授权。

授权前请逐条检查显示的命令。完整威胁模型与残余风险见[安全模型](./docs/security-model.md)。安全边界绕过请通过 [SECURITY.md](./SECURITY.md) 中的私密渠道报告；不要在公开 Issue 中粘贴真实凭据。

## 兼容性

| 项目 | 支持范围 |
| --- | --- |
| Node.js | `^22.19.0` 或 `>=24.0.0` |
| Git | 本地 `PATH` 中可用；目标必须是 Git 仓库 |
| DeepSeek Harness | 已测试 `@deepseek-ai/dsh` `0.1.0-rc.6` |
| 操作系统 | Linux、macOS、Windows CI 矩阵 |
| Codex | 可加载 `.codex-plugin/plugin.json` 或仓库 skill 的版本 |
| Claude Code | 可加载 `.claude-plugin/plugin.json` 的版本；插件依赖由 `npm ci --ignore-scripts` 安装，不会触发构建 |

DSH 仍处于 developer preview。升级 RC 后请重新运行 packed-profile smoke test。

## 安装

### 预构建 Release（推荐）

从 [GitHub 最新 Release](https://github.com/XiaoSong1223/dsh-release-guardian/releases/latest) 下载 tarball，再选择所需入口。

安装到 DSH profile：

```sh
curl -LO https://github.com/XiaoSong1223/dsh-release-guardian/releases/download/v0.1.0/dsh-release-guardian-0.1.0.tgz
npx @deepseek-ai/dsh@0.1.0-rc.6 plugin --profile headless add \
  ./dsh-release-guardian-0.1.0.tgz
npx @deepseek-ai/dsh@0.1.0-rc.6 --profile headless --dump-config
```

安装独立 CLI：

```sh
npm install --global ./dsh-release-guardian-0.1.0.tgz
dsh-release-guardian --help
```

预构建包已包含 JavaScript，无需在安装时授权构建。若从 Git tag 安装，`prepare` 会触发 TypeScript 构建；pnpm 10+ 可能要求在 DSH profile 的 `pnpm-workspace.yaml` 中明确允许 `dsh-release-guardian` 构建。详情见[英文安装说明](./README.md#install)。

### Codex 适配器（可选）

通过 Codex 的插件入口加载本仓库后，让 Codex 使用 `release-guardian` skill。该 skill 优先使用自包含 runner：

```text
skills/release-guardian/scripts/release-guardian.mjs
```

如果找不到包内 runner，适配器会回退到 `PATH` 中的 `dsh-release-guardian`。如果不安装完整插件、而是手动复制 skill，必须复制整个 `skills/release-guardian/` 目录，包括 `scripts/`；只复制 `SKILL.md` 会丢失包内 runner。

仓库为什么包含 `.codex-plugin/plugin.json`？它只是可选 Codex 适配层的分发元数据，用于定位 skill 和展示资源；不会改变 DSH 加载方式、不会在安装时执行检查，也不会让 Codex 成为扫描核心的运行时依赖。

### Claude Code 插件（可选）

本仓库同时是 Claude Code 插件和一个单插件 marketplace。添加 marketplace 后安装插件：

```text
/plugin marketplace add XiaoSong1223/dsh-release-guardian
/plugin install dsh-release-guardian@release-guardian
```

本地检出同样可用（先 `npm ci && npm run build`），把上面的仓库地址换成检出目录的绝对路径即可。

插件提供四个入口：

| 能力 | 说明 |
| --- | --- |
| `/release-guardian` skill | 共享 skill：扫描、解释判定，并在执行任何项目检查前请求用户授权。 |
| `release-auditor` 子代理 | 在独立上下文中执行只读审计，只回传判定、发现与检查计划，避免大 JSON 报告占满主对话。 |
| `dsh-release-guardian` 命令 | `bin/dsh-release-guardian` 会进入 Bash 工具的 `PATH`，无需全局安装即可使用；它只负责定位并转发调用，不增删或改写任何参数。 |
| 提交前拦截（默认关闭） | 开启 `commit_gate` 后，`PreToolUse` 钩子会扫描 `git commit` 将要记录的变更，判定为 `block` 时拒绝该次提交。 |

Claude Code 不会构建本包，因此启动器按以下顺序解析可运行的 CLI：`DSH_RELEASE_GUARDIAN_CLI` 环境变量或插件的 `cli_path` 选项、自包含的 `skills/release-guardian/scripts/release-guardian.mjs`、`lib/cli.js`、`PATH` 中已有的 `dsh-release-guardian`。自包含 runner 排在 `lib/cli.js` 之前，因为它不依赖已安装的 node_modules，而没有 lockfile 的插件来源不会安装依赖。全部失败时退出码为 `69`，并说明需要构建或安装什么，绝不自行安装。

提交前拦截**默认关闭**，可通过插件的 `commit_gate` 选项或 `DSH_RELEASE_GUARDIAN_COMMIT_GATE=1` 打开。它扫描暂存区（`git commit -a` 时扩展为工作区），只输出规则 ID 与路径，不回显发现内容。它是建议性控制而非安全边界：CLI 缺失、扫描失败或超时都会放行提交，并说明拦截未执行。

插件刻意不提供 `allowed-tools` 预授权：`Bash(dsh-release-guardian check:*)` 这样的前缀规则会连带预授权 `--run-checks`，从而绕过执行授权边界。

## 快速使用

```sh
# 工作区相对 HEAD 的变更（默认包含未跟踪普通文件）
dsh-release-guardian check --repo /absolute/path/to/repo

# 只检查暂存区
dsh-release-guardian check --repo /absolute/path/to/repo --mode staged

# 从 origin/main 与 HEAD 的 merge-base 扫描到 HEAD
dsh-release-guardian check --repo /absolute/path/to/repo \
  --base origin/main --head HEAD

# 机器可读报告
dsh-release-guardian check --repo /absolute/path/to/repo --format json

# 先展示计划，再明确批准 test/typecheck
dsh-release-guardian check --repo /absolute/path/to/repo \
  --checks test,typecheck --run-checks

# 规则目录与修复建议
dsh-release-guardian rules
dsh-release-guardian explain RG103
```

不带子命令时默认执行 `check`。完整参数、diff 模式、规则表、退出码和主机工具流程见[英文 README](./README.md#cli)。JSON 消费方请阅读[输出契约](./docs/output-schema.md)。

## 配置

仓库根目录可放置严格校验、版本化的 `.release-guardian.yml`：

```yaml
version: 1

diff:
  include_untracked: true
  max_bytes: 10485760
  exclude:
    - "**/dist/**"
    - "**/node_modules/**"
  generated:
    - "**/*.generated.*"

checks:
  required: [test, typecheck]
  discover:
    max_depth: 4
  commands:
    - id: project-test
      category: test
      cwd: .
      argv: [npm, --offline, run, test]
      required: true

limits:
  max_files: 5000
  max_findings: 500
  max_check_output_bytes: 65536
  max_checks: 256
```

未知字段会被拒绝。策略读取自可信基线提交；当前变更中新建或修改的配置不会在同一次扫描中生效，并会使结果变为不完整。精确字段、camelCase/snake_case 别名及命令约束见[英文配置参考](./README.md#release-guardianyml)。

## 开发与文档

```sh
npm ci
npm run check
npm run pack:check
npm run test:dsh
```

- [测试与验证](./docs/testing.md)
- [JSON 输出契约](./docs/output-schema.md)
- [常见故障](./docs/troubleshooting.md)
- [参与贡献](./CONTRIBUTING.md)
- [版本记录](./CHANGELOG.md)

## License

MIT
