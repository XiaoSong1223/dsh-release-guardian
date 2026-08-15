---
name: release-guardian
description: Scan Git changes with the plugin-bundled Release Guardian runner or an installed dsh-release-guardian CLI, explain release-risk findings and verdicts, discover project checks, and run checks only after explicit user approval. Use for pre-release review, pre-merge risk checks, staged or worktree audits, comparison-range audits, secret and CI risk screening, or machine-readable release reports.
---

# Release Guardian

Use Release Guardian as a local release-risk scanner. Treat it as a decision aid, not a guarantee of safety.

## Resolve the runner

Prefer the self-contained runner shipped with this skill. Resolve the directory containing this loaded `SKILL.md`, then use its `scripts/release-guardian.mjs` with the current Node.js executable. Always pass the runner an absolute path; do not assume the user's repository is the plugin directory.

```sh
node "/absolute/path/to/this/skill/scripts/release-guardian.mjs" --help
```

If that companion script is absent, fall back to `dsh-release-guardian` only after confirming it is available on `PATH`. If neither runner is available, stop and explain that the complete plugin or the standalone CLI must be installed. Do not install software without the user's request.

In the examples below, `dsh-release-guardian` means the resolved invocation: either `node "/absolute/path/to/this/skill/scripts/release-guardian.mjs"` or the confirmed global command.

## Scan safely

1. Resolve the exact repository root before scanning. Use the path the user named, or the current project directory when they named none, and pass the result as an absolute path to `--repo`; never rely on an ambiguous current directory.

   ```sh
   git -C "/path/provided/by/the/user" rev-parse --show-toplevel
   dsh-release-guardian check --repo "/absolute/repository/root" --format json
   ```

   Substitute the resolved invocation from the previous section for `dsh-release-guardian` and keep every option identical.

2. Select the narrowest diff mode matching the request:

   - Use the default `worktree` mode for unstaged, staged, and optionally untracked local work against `HEAD`.
   - Add `--mode staged` for index-only review.
   - Add `--base REF --head REF` for a comparison range. Supplying `--base` selects range mode.

3. Scan first without `--run-checks`. Capture stdout even when the process exits nonzero; verdict exit codes are meaningful and JSON is still produced.

4. Read the JSON fields `schema_version`, `verdict`, `diff`, `check_discovery`, `findings`, `checks`, `diagnostics`, and `warnings`. Require `schema_version` to be `"1"` and tolerate additive fields. Reconcile `files_changed = files_seen + files_excluded + files_unseen` and treat nonzero `files_unseen` or incomplete check discovery as incomplete coverage.

5. Explain the result with concrete rule IDs and repository-relative paths:

   - `ready`: no blocking condition was found within the completed scan; do not call this proof of safety.
   - `review`: human attention is needed.
   - `block`: advise against release until blocking findings or required check failures are resolved.
   - `inconclusive`: the scan or required execution was incomplete; explain the diagnostics and do not treat it as ready.

6. Use `dsh-release-guardian explain RULE_ID` when remediation needs clarification. Never reveal redacted secret material or try to recover it from fingerprints.

## Gate all project-code execution

Never pass `--run-checks` unless the user explicitly approves project-code execution for the current repository and displayed plan.

Before requesting approval:

- Show every proposed check's `id`, `category`, `cwd`, and exact `argv` from the scan JSON.
- State that commands are not sandboxed and run with the user's permissions.
- State that offline, no-restore, and read-only dependency flags are best effort, not a network or filesystem boundary.
- Narrow the plan with `--checks test`, `--checks typecheck`, `--checks build`, a comma-separated category subset, and repeatable `--check-id ID` selections when the user's authorization is narrower.

After explicit approval, run against the same absolute repository in `worktree` mode with untracked files included and no intervening repository changes. Use `--yes` only to carry that approval into a non-interactive invocation:

```sh
dsh-release-guardian check \
  --repo "/absolute/repository/root" \
  --mode worktree \
  --include-untracked true \
  --checks test,typecheck \
  --check-id "sha256:approved-command-id" \
  --format json \
  --run-checks \
  --yes
```

Do not infer approval from `.release-guardian.yml`; configured argv arrays only add commands to the plan. Do not install dependencies, publish, deploy, or run unrelated commands as part of this workflow.

## Report succinctly

Lead with the verdict. Summarize blocking and review findings by severity, note whether the diff was truncated, and distinguish checks that passed, failed, timed out, were unavailable, or were not run. Include the exact repository path and diff mode so the scope is auditable.
