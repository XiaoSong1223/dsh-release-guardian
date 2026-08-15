# Changelog

All notable changes to DSH Release Guardian are documented here.

## Unreleased

### Added

- Claude Code plugin manifest and single-plugin marketplace entry in `.claude-plugin/`.
- `bin/dsh-release-guardian` launcher, which puts the CLI on a Claude Code session's `PATH` without a global install and forwards arguments and exit codes unchanged.
- Read-only `release-auditor` subagent that keeps a full JSON report out of the main conversation.
- Opt-in `PreToolUse` commit gate that scans what a `git commit` would record and denies the commit on a `block` verdict.

### Security

- The commit gate is off by default, reports only rule IDs and paths, and never crosses the project-code execution boundary.
- The plugin ships no `allowed-tools` pre-approval, because a `dsh-release-guardian check` prefix rule would also pre-approve `--run-checks`.

## 0.1.0 - 2026-08-15

### Added

- Deterministic worktree, staged, and merge-base range audits.
- Context-aware release-risk rules with centralized credential redaction.
- Git-visible test, typecheck, and build discovery for JavaScript, Python, Go, Rust, Java, and .NET projects.
- Exact, state-bound approval IDs for optional project-check execution.
- Versioned JSON and human-readable reports with diff-coverage accounting.
- DeepSeek Harness bundle registration and an isolated packed-profile smoke test.
- Codex plugin manifest and reusable Release Guardian skill.
- Cross-platform CI for macOS, Linux, and Windows on supported Node versions.

### Security

- Trusted baseline policy prevents an audited change from weakening its own scan.
- Exclusion and generated-file settings cannot hide mandatory secret or critical-operation rules.
- Diff, finding, discovery, process-output, and authorization limits fail closed.
