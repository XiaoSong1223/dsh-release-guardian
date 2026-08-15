# Changelog

All notable changes to DSH Release Guardian are documented here.

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
