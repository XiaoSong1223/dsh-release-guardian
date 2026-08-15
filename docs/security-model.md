# Security model

Release Guardian separates static inspection from project-code execution. The default `check` operation is read-only with respect to the target repository: it runs local Git commands and reads configuration and manifest files, but it does not execute project code.

Release Guardian has zero telemetry. It does not install project dependencies, publish packages, deploy software, or claim that a `ready` result proves a release is safe.

## Execution boundary

Project checks are a separate, explicitly authorized operation:

- The CLI runs them only with `--run-checks`; it displays the exact plan and asks for confirmation. Non-interactive use also requires `--yes`.
- The DSH host tool runs them only with `action: "run"` and exact command IDs from a prior discovery response. The host also requests approval at the tool boundary.
- The Codex skill must show every proposed check's ID, category, working directory, and exact argv before carrying explicit user authorization into a run.
- The Claude Code plugin adds no execution path of its own. Its launcher forwards arguments to the same CLI without adding or removing a flag, its subagent is forbidden from passing `--run-checks`, and its commit gate calls only the read-only `check` path. The plugin also ships no `allowed-tools` pre-approval, because a `dsh-release-guardian check` prefix rule would also pre-approve `--run-checks`.
- Approved commands are **not sandboxed**. They run with the invoking user's permissions in the target repository.
- Discovery adds offline, no-restore, or read-only dependency flags where supported, and execution uses a reduced environment. These controls are best effort, not a network or filesystem security boundary.

Review every displayed command before authorizing it.

## Authorization binding

Execution is allowed only for a complete `worktree` scan with untracked files included. Approval IDs are derived from the canonical repository, effective baseline policy, manifest plan, and exact diff fingerprint. Any relevant source or configuration change invalidates prior approval.

Configured commands may contain arbitrary argv. Adding a command to `.release-guardian.yml` only adds it to discovery; configuration is never an execution grant. Commands execute directly as argv with `shell: false`, so shell syntax is not implicitly interpreted.

## Trusted policy and coverage

Policy comes from the trusted baseline commit: `HEAD` for worktree/staged scans and the merge base for a range scan. A policy file introduced or changed by the audited diff is not trusted for that same scan and makes the result incomplete.

Diff collection disables repository-supplied external diff drivers and text conversion. Limits fail closed: truncated or otherwise unseen input produces an incomplete result and cannot become `ready`. Policy exclusions and generated-file classifications may reduce non-blocking noise, but they do not suppress credential rules or adjudicated blocking rules.

Repository and configuration paths are canonicalized and constrained to the target repository. Untracked symlinks and non-regular files are not followed as normal source input. These checks reduce path-confusion risk but do not turn approved project commands into a sandbox.

## Secrets and private data

Recognized secret evidence in findings is redacted and fingerprinted. Captured check output is bounded and passed through redaction patterns before reporting. Pattern-based redaction cannot guarantee removal of every possible sensitive value, so treat reports and check output as potentially private.

Do not:

- paste real credentials or private repository output into public issues;
- attempt to recover a secret from redacted evidence or fingerprints;
- upload a report to a third party without reviewing its repository paths, diagnostics, and command output;
- assume zero telemetry means authorized project checks cannot access the network.

## Threats addressed

The design specifically aims to detect common release risks in the selected Git change and to prevent accidental execution through the scanner itself. Security-sensitive invariants include:

- blocking rules cannot be bypassed through ordinary exclusions, generated policy, truncation, or an untrusted config change;
- no project check runs without a current exact command authorization;
- approval cannot be reused across materially different repository states;
- repository-relative paths cannot escape the canonical root during scanning or configuration loading;
- findings and captured output apply bounded redaction;
- check argv is not interpreted through a shell.

## Non-goals and residual risk

- Rules are deterministic heuristics, not comprehensive static analysis or a secret-management product.
- A clean selected diff says nothing about unscanned history, dependencies, deployment state, or runtime behavior.
- Check discovery does not prove that a tool is installed or that its dependencies are available.
- An approved build or test can execute arbitrary repository code with the user's permissions.
- Offline flags vary by ecosystem and are not an enforcement boundary.
- The Claude Code commit gate is advisory. It is off by default, it denies only on a `block` verdict, and a missing CLI, failed scan, or timeout allows the commit and says the gate did not run. It is not a substitute for a server-side pre-receive control.

Report a boundary bypass through the private process in [SECURITY.md](../SECURITY.md). Ordinary false positives and synthetic rule-coverage examples may use the public issue tracker.
