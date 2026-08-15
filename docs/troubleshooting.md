# Troubleshooting

Start with the standalone help and a read-only JSON scan:

```sh
dsh-release-guardian --help
dsh-release-guardian check --repo /absolute/path/to/repo --format json
```

The report usually contains actionable details in `diagnostics` and `warnings`, even when the exit code is nonzero.

## Installation

### `dsh-release-guardian: command not found`

Install a built tarball globally, or invoke the checkout's built CLI directly:

```sh
npm install --global ./dsh-release-guardian-0.1.0.tgz
dsh-release-guardian --help

# Development checkout
npm ci
npm run build
node lib/cli.js --help
```

Confirm that npm's global binary directory is on `PATH`. A source checkout does not contain `lib/` until it is built.

### DSH Git install asks to run a build

A pinned Git source runs this package's `prepare` script. pnpm 10 and newer require an explicit build allowance in the DSH profile. Review the pinned source, add `dsh-release-guardian: true` under `allowBuilds` in that profile's `pnpm-workspace.yaml`, and repeat the install.

If install-time builds are undesirable, use the prebuilt tarball from the GitHub release. It already contains the built JavaScript.

### DSH starts but the tool is missing

1. Verify the package was added to the same profile you booted.
2. Dump that profile's configuration and look for the `release-guardian` bundle patch:

   ```sh
   npx @deepseek-ai/dsh@0.1.0-rc.6 --profile headless --dump-config
   ```

3. Confirm the installed package contains `lib/index.js` and `cordis.patch.yml`.
4. Re-run the packed-profile smoke test when using a DSH version other than the documented release candidate.

DeepSeek Harness is a developer preview; RC compatibility is intentionally exact.

## Codex adapter

### Codex cannot find the skill

Install/load the repository as a Codex plugin or copy the entire `skills/release-guardian/` directory into a Codex skill location. `.codex-plugin/plugin.json` points Codex at the packaged `skills/` directory; it is unrelated to DSH profile activation.

### The bundled runner is missing

A direct skill copy must contain both:

```text
skills/release-guardian/SKILL.md
skills/release-guardian/scripts/release-guardian.mjs
```

Copying only `SKILL.md` removes the self-contained runner. Restore the complete directory or install a compatible `dsh-release-guardian` globally so the adapter's `PATH` fallback can be used.

### The runner reports that Node.js or Git is unavailable

The adapter still requires a compatible Node.js runtime (`^22.19.0` or `>=24.0.0`) and Git on `PATH`. Language toolchains are needed only after you explicitly authorize their discovered checks.

## Claude Code plugin

### `dsh-release-guardian: no runnable CLI found` (exit 69)

The plugin was installed from a source without built output, and no other installation was found. Claude Code installs plugin dependencies with `npm ci --ignore-scripts`, so it never builds this package. Fix it with one of:

```sh
# Build the installed plugin in place
cd ~/.claude/plugins/cache/release-guardian/dsh-release-guardian/<version> && npm ci && npm run build

# Or install the release tarball globally and let the launcher fall back to PATH
npm install --global ./dsh-release-guardian-0.1.0.tgz

# Or point the launcher at an existing installation
export DSH_RELEASE_GUARDIAN_CLI=/absolute/path/to/lib/cli.js
```

The plugin's `cli_path` option does the same thing as the environment variable.

### The commit gate never runs

The gate is off by default. Turn on the plugin's `commit_gate` option, or export `DSH_RELEASE_GUARDIAN_COMMIT_GATE=1` for the session. The hook matches `git commit` only, so `git push` and other commands are never gated.

### The commit gate says a commit was not scanned

The gate is advisory and fails open by design: a missing CLI, a scan that could not start, a timeout, or an unreadable report allows the commit and reports why. Run `dsh-release-guardian check --repo "$PWD" --mode staged` directly to see the underlying error.

### A commit was denied and the diff looks clean

The gate scans staged changes, or the whole worktree for `git commit -a`, and denies only on a `block` verdict. Run the same scan yourself and use `dsh-release-guardian explain RULE_ID` for remediation. Disabling `commit_gate` removes the gate but not the finding.

## Scan and configuration errors

### `configuration ... contains unknown fields`

Configuration is strict and versioned. Use only the fields documented in [the README](../README.md#release-guardianyml), and set `version: 1`. Configuration is read from the trusted baseline, so a config change in the same audited diff is reported as untrusted and makes that scan inconclusive.

### `range mode requires --base`

Pass a comparison base:

```sh
dsh-release-guardian check --repo /absolute/path/to/repo \
  --base origin/main --head HEAD
```

`--base` selects range mode and cannot be combined with an explicitly selected non-range mode.

### `inconclusive` or exit code 3

Inspect `diagnostics`, `diff.truncated`, `diff.files_unseen`, and `check_discovery.complete`. Common causes are:

- the diff, file, finding, or discovery limit was reached;
- a required check category could not be discovered;
- `.release-guardian.yml` changed in the audited diff;
- a stale/unknown command ID was supplied;
- check execution was requested outside a complete worktree scan with untracked files included;
- Git could not resolve the requested ref or read the repository.

Increase a limit only after confirming the target repository and expected scope. An incomplete scan should not be converted to success by ignoring exit code 3.

### A file was excluded unexpectedly

Inspect `diff.exclusions`, which reports the effective pattern, count, and bounded path samples. Credential and blocking rules are not suppressed by ordinary exclusions. Remember that baseline policy, not a newly edited working-copy policy, governs the current audit.

## Check execution

### Non-interactive execution rejects `--run-checks`

First run a discovery-only JSON scan and review every command. After explicit authorization, repeat the complete worktree scan with `--run-checks --yes`, ideally selecting exact `--check-id` values. `--yes` carries approval into a non-interactive invocation; it does not make a command safe.

### `--check-id was not found in the current plan`

The repository, effective policy, manifest, or diff changed after discovery, or the ID came from another repository. Re-run discovery, review the new exact plan, and request fresh approval. Do not reuse IDs.

### A check is `unavailable`, `timed_out`, or has truncated output

- `unavailable`: install/restore the relevant tool only if the user wants that check executed, then discover again.
- `timed_out`: use `--timeout SECONDS` for the invocation or `timeoutSeconds` on that configured command.
- `output_truncated: true`: only the bounded output tail was retained. Consult the tool directly only under the same execution authorization and privacy constraints.

Approved checks are unsandboxed and can modify files or use the network despite best-effort offline flags. Review the [Security model](./security-model.md) before automation.
