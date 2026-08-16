# DSH Release Guardian

<p align="center">
  <img src="./assets/readme-hero.png" alt="DSH Release Guardian — deterministic release-risk checks for Git changes" width="100%" />
</p>

[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-0.1.0--rc.6-4c46e5)](https://github.com/deepseek-ai/deepseek-harness)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

[简体中文](./README.zh-CN.md) · [Architecture](./docs/architecture.md) · [Security model](./docs/security-model.md) · [Troubleshooting](./docs/troubleshooting.md)

Local, deterministic release-risk checks for Git changes. Use the same scanner through a DeepSeek Harness host tool, a standalone CLI, an optional Codex skill adapter, or an optional Claude Code plugin.

中文概览：Release Guardian 在本机读取 Git 变更，检查新增代码和变更文件中的发布风险，并发现常见项目检查。默认只读，不执行项目代码；只有用户明确授权后才会运行所展示的检查命令。

## What v0.1 does

- Scans `worktree`, `staged`, or `range` Git changes.
- Applies deterministic rules to changed-file metadata and added lines.
- Discovers test, typecheck, and build commands for JavaScript, Python, Go, Rust, Java, and .NET projects.
- Produces a human-readable report or a versioned JSON report.
- Registers the `release_guardian_check` tool when installed as a DeepSeek Harness bundle.
- Gives Codex a safety-aware workflow through the optional `release-guardian` skill.
- Installs into Claude Code as a plugin: the `release-guardian` skill, a read-only `release-auditor` subagent, a `dsh-release-guardian` command on the session `PATH`, and an opt-in pre-commit gate.

Release Guardian is a risk signal, not a proof that a release is safe. A `ready` verdict means that this scan found no release-blocking condition within its configured scope.

## Choose an entry point

All entry points use the same release-report contract and the same explicit authorization boundary for project checks.

| Entry point | Best for | How it runs |
| --- | --- | --- |
| **DSH bundle** | DeepSeek Harness profiles and tool calling | Installs the package bundle and registers `release_guardian_check`. |
| **Standalone CLI** | Terminals, local scripts, and CI | Runs the packaged `dsh-release-guardian` executable. |
| **Codex adapter (optional)** | Guided audits in Codex | Loads `skills/release-guardian/SKILL.md`; it prefers the bundled runner and falls back to `dsh-release-guardian` on `PATH` when the runner is unavailable. |
| **Claude Code plugin (optional)** | Guided audits and an opt-in commit gate in Claude Code | Loads `.claude-plugin/plugin.json`; puts `dsh-release-guardian` on the Bash tool's `PATH` through `bin/`, and shares the same skill. |

These are adapters, not separate scanners. See [Architecture](./docs/architecture.md) for the component and trust-boundary map.

## Safety model

The default `check` operation is read-only with respect to the target repository. It runs local Git commands and reads configuration and manifest files, but it does not execute project code. Release Guardian itself has zero telemetry and does not install project dependencies, publish packages, or deploy software.

Project checks are a separate, explicitly authorized operation:

- The CLI runs them only with `--run-checks`; it displays the exact plan and asks for confirmation. Non-interactive use also requires `--yes`.
- The host tool runs them only with `action: "run"` and exact command IDs from a prior discovery response.
- Approved commands are **not sandboxed**. They run with the invoking user's permissions in the repository.
- Discovery adds offline/no-restore/read-only flags where supported and execution uses a reduced environment, but these controls are best effort. They are not a network or filesystem security boundary.
- Execution is allowed only for a complete `worktree` scan with untracked files included. Approval IDs are bound to the canonical repository, effective baseline policy, and exact diff fingerprint; any source or configuration change invalidates prior approval.
- Configured commands may contain arbitrary argv. Merely placing a command in `.release-guardian.yml` discovers it; configuration is never an execution grant.

Review every displayed command before authorizing it.

Report security-boundary bypasses through the private process in [SECURITY.md](./SECURITY.md); never paste a real credential into a public issue.

Development setup and pull-request expectations are documented in [CONTRIBUTING.md](./CONTRIBUTING.md). Release notes are in [CHANGELOG.md](./CHANGELOG.md).

## Requirements

- Node.js `^22.19.0` or `>=24.0.0`
- Git
- The relevant language toolchains only if checks will be executed
- For the DeepSeek Harness route: `pnpm` plus either `dsh` on `PATH` or the official `npx @deepseek-ai/dsh` launcher

The host bundle is tested against `@deepseek-ai/dsh` `0.1.0-rc.6`. DeepSeek Harness is still a developer preview, so re-run the packed-profile smoke test when upgrading RC versions.

## Compatibility

| Surface | Supported / tested | Notes |
| --- | --- | --- |
| Node.js | `^22.19.0` or `>=24.0.0` | Required by the CLI, bundle, and bundled Codex runner. |
| Git | Current Git with the CLI available on `PATH` | A target must be a local Git repository. |
| DeepSeek Harness | `@deepseek-ai/dsh` `0.1.0-rc.6` | Developer preview; exact packed-profile smoke coverage is recorded in CI. |
| Package managers | npm for building/installing; pnpm for the DSH profile | Git-source DSH installs may require explicit pnpm build approval. |
| Codex adapter | Codex installations that load `.codex-plugin/plugin.json` or repository skills | Optional; direct skill copies must include the skill's `scripts/` directory. |
| Claude Code plugin | Claude Code releases that load `.claude-plugin/plugin.json` | Optional; the `if` hook filter and `userConfig` options require a current Claude Code. Claude Code installs plugin dependencies with `npm ci --ignore-scripts`, so it never builds this package. |
| Operating systems | Linux, macOS, Windows | Exercised by the Node.js CI matrix; language-specific checks also require their own toolchains. |

## Install

### Prebuilt GitHub release (recommended)

Download the prebuilt tarball from the [latest GitHub release](https://github.com/XiaoSong1223/dsh-release-guardian/releases/latest), then install it into a DSH profile:

```sh
curl -LO https://github.com/XiaoSong1223/dsh-release-guardian/releases/download/v0.1.0/dsh-release-guardian-0.1.0.tgz
npx @deepseek-ai/dsh@0.1.0-rc.6 plugin --profile headless add \
  ./dsh-release-guardian-0.1.0.tgz
npx @deepseek-ai/dsh@0.1.0-rc.6 --profile headless --dump-config
```

The release tarball contains built JavaScript and does not require permission to execute a package build during installation.

### Install directly from GitHub

DSH also accepts a pinned GitHub source:

```sh
npx @deepseek-ai/dsh@0.1.0-rc.6 plugin --profile headless add \
  github:XiaoSong1223/dsh-release-guardian#v0.1.0
```

Git installs run this TypeScript package's `prepare` build. pnpm 10 and newer require the profile to explicitly allow that build. Review the pinned source, add `dsh-release-guardian: true` under `allowBuilds` in the profile's `pnpm-workspace.yaml`, and repeat the command. Prefer the prebuilt release tarball when you do not want to grant install-time build permission.

### Build from a checkout

From this checkout, install Release Guardian's own dependencies and build a package tarball:

```sh
npm ci
npm pack
```

`npm pack` runs the package `prepare` script, so the resulting `dsh-release-guardian-0.1.0.tgz` contains built JavaScript.

### Standalone CLI

Install the built tarball globally:

```sh
npm install --global ./dsh-release-guardian-0.1.0.tgz
dsh-release-guardian --help
```

For development without a global install, build and invoke `node lib/cli.js` from this checkout.

### DeepSeek Harness bundle

Add the same built tarball to the desired DSH profile:

```sh
dsh plugin --profile headless add ./dsh-release-guardian-0.1.0.tgz

# No global dsh installation is required:
npx @deepseek-ai/dsh@0.1.0-rc.6 plugin --profile headless add \
  ./dsh-release-guardian-0.1.0.tgz
```

Replace `headless` with the profile you use. `dsh plugin` initializes a missing profile, forwards `add` to pnpm in that profile, and activates this package's `cordis.patch.yml` bundle. Boot the profile normally; it exposes the `release_guardian_check` host tool. This package does not provide a Web UI.

### Optional Codex adapter

This repository is also a Codex plugin bundle. Install or load the repository through Codex's plugin controls, then ask Codex to use the `release-guardian` skill for a release audit. The skill calls its self-contained runner at:

```text
skills/release-guardian/scripts/release-guardian.mjs
```

The runner makes the adapter work from the installed plugin without requiring a global CLI. If the companion script is unavailable, the adapter may fall back to `dsh-release-guardian` on `PATH`, which is useful for development and older package layouts.

If you copy the skill manually instead of installing the plugin bundle, copy the **entire** `skills/release-guardian/` directory, including `scripts/release-guardian.mjs`. Copying only `SKILL.md` removes the bundled runner; in that case the adapter works only when a compatible `dsh-release-guardian` is already on `PATH`.

Why does a DSH package contain `.codex-plugin/plugin.json`? It is distribution metadata for the optional Codex adapter: it tells Codex where the packaged skills and presentation assets live. It does not change DSH loading, register the DSH host tool, execute code at install time, or make Codex a runtime dependency of the scanner. Keeping this manifest in the same release artifact lets the DSH bundle, CLI, and Codex skill share one reviewed implementation and version.

See [Troubleshooting](./docs/troubleshooting.md#codex-adapter) if Codex cannot find the skill or runner.

### Optional Claude Code plugin

This repository is also a Claude Code plugin and a single-plugin marketplace. Add the marketplace, then install the plugin:

```text
/plugin marketplace add XiaoSong1223/dsh-release-guardian
/plugin install dsh-release-guardian@release-guardian
```

A local checkout works the same way and is the recommended way to try changes:

```sh
npm ci && npm run build
```

```text
/plugin marketplace add /absolute/path/to/dsh-release-guardian
/plugin install dsh-release-guardian@release-guardian
```

The plugin adds four surfaces:

| Surface | What it does |
| --- | --- |
| `/release-guardian` skill | The shared skill: scan, explain the verdict, and request approval before any project check runs. |
| `release-auditor` subagent | Runs a read-only audit in its own context and returns the verdict, findings, and check plan, so a large JSON report never fills the main conversation. |
| `dsh-release-guardian` command | `bin/dsh-release-guardian` is placed on the Bash tool's `PATH`, so the CLI works in a session without a global install. It only locates and executes the real CLI; it never adds, removes, or rewrites a flag. |
| Pre-commit gate (opt-in) | With the `commit_gate` option enabled, a `PreToolUse` hook scans what a `git commit` would record and denies the commit on a `block` verdict. |

Claude Code never builds this package, so the launcher resolves a runnable CLI in this order: the `DSH_RELEASE_GUARDIAN_CLI` environment variable or the plugin's `cli_path` option, then the self-contained `skills/release-guardian/scripts/release-guardian.mjs`, then `lib/cli.js`, then a `dsh-release-guardian` already on `PATH`. The bundled runner comes before `lib/cli.js` because it needs no installed dependencies, and a plugin source without a lockfile never gets them. If nothing resolves, the launcher exits `69` and prints what to build or install; it never installs anything itself.

The pre-commit gate is **off by default**. Enable it per user or project with the plugin's `commit_gate` option, or by exporting `DSH_RELEASE_GUARDIAN_COMMIT_GATE=1`. It scans `staged` changes, or the worktree for `git commit -a`, and reports only rule IDs and paths, never finding text. It is advisory, not a security boundary: a missing CLI, a timeout, or an unreadable report allows the commit and says the gate did not run.

The plugin deliberately ships no `allowed-tools` pre-approval for the skill. A `Bash(dsh-release-guardian check:*)` rule would also pre-approve `--run-checks`, which would defeat the execution gate, so each command follows the session's normal permission flow.

## CLI

```text
dsh-release-guardian check [options]
dsh-release-guardian rules
dsh-release-guardian explain RULE_ID
```

With no command, the CLI defaults to `check`.

Common examples:

```sh
# Unstaged, staged, and optionally untracked work against HEAD
dsh-release-guardian check --repo /absolute/path/to/repo

# Index changes against HEAD
dsh-release-guardian check --repo /absolute/path/to/repo --mode staged

# Changes from the merge base of origin/main and HEAD through HEAD
dsh-release-guardian check --repo /absolute/path/to/repo --base origin/main --head HEAD

# Stable machine-readable report
dsh-release-guardian check --repo /absolute/path/to/repo --format json

# Discover and then explicitly approve the displayed test/typecheck plan
dsh-release-guardian check --repo /absolute/path/to/repo \
  --checks test,typecheck --run-checks

# After a static JSON scan, execute only one previously displayed check ID
dsh-release-guardian check --repo /absolute/path/to/repo \
  --checks test --check-id sha256:... --run-checks

# Rule inventory and remediation details
dsh-release-guardian rules
dsh-release-guardian explain RG103
```

### Check options

| Option | Meaning |
| --- | --- |
| `--repo PATH` | Repository path; defaults to the current directory. |
| `--mode worktree\|staged\|range` | Select the diff mode. Supplying `--base` implies `range`. |
| `--base REF` | Base ref for range mode. The scanner uses its merge base with `--head`. |
| `--head REF` | Head ref; defaults to `HEAD`. |
| `--include-untracked true\|false` | Include untracked regular files in worktree mode; defaults to `true`. |
| `--config PATH` | Repository-contained config path; defaults to `.release-guardian.yml`. |
| `--format text\|json` | Report format; defaults to `text`. |
| `--output PATH` | Create a report file with mode `0600`; an existing file is never overwritten. |
| `--checks LIST` | Comma-separated subset of `test,typecheck,build`. |
| `--check-id ID` | Execute only this exact discovered check ID; repeat to select more than one. Requires `--run-checks`. |
| `--run-checks` | Execute the displayed check plan after authorization. |
| `--yes` | Confirm non-interactively; valid only with `--run-checks`. |
| `--fail-on review\|block` | Exit threshold; defaults to `block`. |
| `--max-diff-bytes N` | Override the diff byte limit. |
| `--timeout SECONDS` | Set the per-check execution timeout for this invocation. |
| `--help` | Show help. |

`range` mode requires `--base`. `--base` conflicts with an explicitly selected non-range mode.

### Verdicts and exit codes

| Verdict or condition | Exit code |
| --- | ---: |
| `ready` | 0 |
| `review` with the default `--fail-on block` | 0 |
| `review` with `--fail-on review` | 1 |
| `block` | 2 |
| `inconclusive`, incomplete scan, or fatal audit failure | 3 |
| CLI usage error | 64 |

The `rules` and successful `explain` commands exit 0.

## Diff modes

- `worktree` compares the working tree with `HEAD`; untracked files are included by default.
- `staged` scans index changes against `HEAD`; untracked files are not part of this mode.
- `range` computes `merge-base(BASE, HEAD_REF)` and scans through `HEAD_REF`. Range and staged scans are read-only review scopes; project checks execute only in full worktree mode.

Diffs are collected with external diff drivers and text conversion disabled. Limits fail closed: truncation produces `RG405` and an `inconclusive` verdict.

## Rules

Rules inspect only the selected change: changed-file metadata plus added lines, except where a rule explicitly concerns deletion, binary content, or truncation. Evidence for recognized secrets is redacted in reports.

| ID | Detection | Severity / disposition |
| --- | --- | --- |
| RG001 | High-confidence credential token | critical / block |
| RG002 | Private key material | critical / block |
| RG003 | Probable secret assignment | high / review |
| RG004 | Embedded URL or bearer credential | critical / block |
| RG005 | Sensitive file added | high / review |
| RG101 | Dependency manifest or lockfile changed | medium / review |
| RG102 | Package lifecycle script changed | high / review |
| RG103 | Downloaded or encoded content executed | critical / block |
| RG201 | Broad CI write permissions | high / review |
| RG202 | Untrusted pull-request workflow risk | critical / block |
| RG203 | Workflow action uses a floating reference | medium / review |
| RG204 | Release or deployment configuration changed | high / review |
| RG301 | TLS verification disabled | critical / block |
| RG302 | Shell execution entry point added | high / review |
| RG303 | Dynamic code evaluation added | high / review |
| RG304 | Privilege or host-boundary weakening | critical / block |
| RG305 | Destructive operation added | high / review |
| RG306 | Authentication or access policy weakened | high / review |
| RG401 | Tests removed or substantial test lines deleted | medium / review |
| RG402 | Test skipped or disabled | medium / review |
| RG403 | Schema, migration, or public API changed | medium / review |
| RG404 | Binary content could not be scanned | medium / review |
| RG405 | Scan input or finding output was truncated | high / review |

Run `dsh-release-guardian explain RULE_ID` for the remediation attached to a rule.

## Check discovery

Discovery reads manifests without running them. In Git repositories it considers only tracked files and untracked files not ignored by Git, then applies intrinsic exclusions for virtual environments, dependency trees, build output, and nested agent worktrees. It looks to the configured manifest depth (default 4), prefers configured commands, de-duplicates equivalent plans, and returns at most 256 checks by default. The report includes candidate, returned, limit, truncation, and completeness counts.

| Ecosystem | Inputs | Discovered commands |
| --- | --- | --- |
| JavaScript | `package.json` scripts and nearest lockfile or `packageManager` field | `test`, `typecheck`, and `build` scripts via npm, pnpm, yarn, or bun; offline flags where available |
| Python | `pyproject.toml`, `pytest.ini`, `tox.ini`, `mypy.ini` | pytest, tox `--no-provision`, mypy, and build `--no-isolation`; uses an executable project-local `.venv`/`venv` interpreter when present |
| Go | `go.mod` | `go test`, `go vet`, and `go build` with `-mod=readonly` |
| Rust | `Cargo.toml` | workspace test, check, and build with `--offline --all-targets` |
| Java | `pom.xml`, `build.gradle*` | Maven or Gradle test/build with offline flags; repository wrappers are preferred |
| .NET | `.sln`, `.csproj` | `dotnet test` and `dotnet build` with `--no-restore` |

Discovery does not verify that a tool or dependency is installed. Availability is determined only if the user authorizes execution.

## `.release-guardian.yml`

The configuration is strict: `version` must be `1`, and unknown fields are rejected. The implemented top-level keys are only `version`, `diff`, `checks`, and `limits`.

```yaml
version: 1

diff:
  include_untracked: true
  max_bytes: 10485760
  exclude:
    - "**/.claude/worktrees/**"
    - "**/.codex/worktrees/**"
    - "**/.venv/**"
    - "**/vendor/**"
    - "**/dist/**"
    - "**/node_modules/**"
    - "**/*.min.js"
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

Implemented camelCase/snake_case aliases are:

| Section | Accepted names |
| --- | --- |
| `diff` | `includeUntracked` / `include_untracked`; `maxBytes` / `max_bytes`; `exclude`; `generated` |
| `checks.discover` | `maxDepth` / `max_depth` |
| `limits` | `maxFiles` / `max_files`; `maxFindings` / `max_findings`; `maxCheckOutputBytes` / `max_check_output_bytes`; `maxChecks` / `max_checks` |

`checks.required` accepts only `test`, `typecheck`, and `build`. Each `checks.commands` entry accepts only:

- `id`: stable identifier containing letters, digits, `.`, `_`, or `-` (maximum 64 characters)
- `category`: `test`, `typecheck`, or `build`
- `cwd`: non-empty repository-relative directory
- `argv`: non-empty array of non-empty strings; it is never interpreted as a shell command
- `required`: optional boolean, default `true`
- `timeoutSeconds`: optional positive integer

`timeoutSeconds` overrides the invocation/host-wide timeout for that configured command.

Configured commands are only added to the displayed plan. They still require the same explicit execution authorization as discovered commands.

Project policy is loaded from the trusted baseline commit (`HEAD` for worktree/staged scans and the merge base for range scans). A policy file introduced or modified by the audited change does not take effect for that same scan and makes the result incomplete. `diff.exclude` and `diff.generated` reduce non-blocking noise, but they never suppress credential rules or a rule whose adjudicated disposition is `block`.

## JSON report contract

`--format json` and the host tool emit the same snake_case report with `schema_version: "1"`. It includes the verdict, repository and diff metadata, summary counts, changed files, contextual findings, check plans/results, diagnostics, warnings, and duration. Additive coverage fields include:

- `diff.files_changed`, `files_seen`, `files_excluded`, and `files_unseen`, which reconcile the selected Git scope;
- `diff.exclusions`, which lists the effective pattern, count, and bounded path samples;
- `diff.fingerprint` and `candidate_lines_scanned`, which make authorization and scan scope auditable;
- `check_discovery`, which reports completeness, candidates, returned checks, limit, truncation, its `current_worktree` source, and whether that source matches the selected diff scope;
- each file's separate `change_status` and `content_kind`, so binary or uninspected content does not hide whether a path was added, modified, deleted, renamed, or untracked;
- each finding's `context`, `rationale`, and `occurrences`.

Consumers should require the expected `schema_version`, tolerate additive fields, and use names rather than field order. Fields documented for schema version `1` are the v0.1 machine-readable contract; an incompatible report-format change requires a new `schema_version`.

## Host tool flow

Call `release_guardian_check` with an absolute `repo_path`. The request schema version is also `"1"`.

1. Call with `action: "discover"` (or omit `action`) to scan and receive the JSON report and check plan.
2. Show the verdict, findings, and each check's exact `id`, `cwd`, and `argv` to the user.
3. Only after explicit authorization, call with `action: "run"` and the exact `approved_command_ids` from that discovery response. Use the same repository in `worktree` mode with untracked files included and without intervening source/configuration changes.

Supported host inputs are `schema_version`, `repo_path`, `config_path`, `mode`, `base`, `head`, `include_untracked`, `max_diff_bytes`, `categories`, `action`, and `approved_command_ids`.

## Documentation

- [Architecture](./docs/architecture.md): shared core, entry-point adapters, data flow, and packaging.
- [JSON output schema](./docs/output-schema.md): schema version `1` fields and consumer guidance.
- [Security model](./docs/security-model.md): execution boundary, authorization binding, and residual risk.
- [Troubleshooting](./docs/troubleshooting.md): installation, DSH, Codex, scanning, and execution failures.
- [Testing and verification](./docs/testing.md): local gates, coverage areas, and the packed-profile smoke test.

## Development

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run check
npm run guardian:self
```

`npm run check` runs typechecking, a production/Codex-runner build, tests, package verification, `publint`, and the pack check. `npm run guardian:self` expects built output and scans this checkout without executing its discovered checks.

## License

MIT
