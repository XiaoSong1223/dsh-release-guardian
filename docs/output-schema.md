# JSON output schema

`dsh-release-guardian check --format json` and the DSH `release_guardian_check` tool return the same snake_case report. Consumers must require `schema_version: "1"`, tolerate additive fields, and address fields by name rather than order.

An incompatible semantic or structural change requires a new schema version. `tool_version` identifies the producer release; it is not a substitute for `schema_version`.

## Top-level object

| Field | Type | Meaning |
| --- | --- | --- |
| `schema_version` | string | Machine-readable contract version; currently `"1"`. |
| `tool_version` | string | Release Guardian version. |
| `verdict` | object | Overall status, risk score, and reason codes. |
| `repository` | object | Canonical root, resolved refs, and worktree-dirty signal. |
| `diff` | object | Selected scope, coverage accounting, fingerprint, and truncation state. |
| `check_discovery` | object | Discovery completeness and whether its worktree source matches the diff scope. |
| `summary` | object | Finding and check-result counts. |
| `files` | array | Inspected, non-policy-excluded changed files. |
| `findings` | array | Rule matches with redacted evidence and remediation. |
| `checks` | array | Discovered argv plans and, when approved, execution results. |
| `diagnostics` | string[] | Coverage failures and operational errors that affect interpretation. |
| `warnings` | string[] | Non-fatal scope and discovery cautions. |
| `duration_ms` | integer | End-to-end audit duration. |

## Verdict

`verdict.status` is one of:

| Status | Interpretation |
| --- | --- |
| `ready` | The completed scan found no release-blocking condition in its configured scope. This is not proof that the release is safe. |
| `review` | At least one result needs human attention. |
| `block` | A blocking finding or required check result advises against release. |
| `inconclusive` | The scan, discovery, authorization validation, or required execution was incomplete. Never treat it as ready. |

`verdict.risk_score` is a bounded summary signal. Automations should gate primarily on `status` and reason codes, not invent stable semantics for a particular numeric score.

## Diff coverage

Important `diff` fields are:

- `mode`: `worktree`, `staged`, or `range`.
- `files_changed`: all file candidates in the selected Git scope.
- `files_seen`: candidates inspected by the scanner.
- `files_excluded`: candidates excluded from ordinary non-blocking analysis by effective policy.
- `files_unseen`: candidates not inspected because coverage was incomplete.
- `exclusions`: each effective pattern, count, and a bounded list of sample paths.
- `fingerprint`: digest of the audited repository state used in command authorization binding.
- `candidate_lines_scanned`, `added_lines_seen`, and `deleted_lines_seen`: bounded coverage counters.
- `truncated`: whether an input limit prevented complete scanning.

The accounting invariant is:

```text
files_changed = files_seen + files_excluded + files_unseen
```

A nonzero `files_unseen`, a true `truncated`, an `RG405` finding, or a relevant diagnostic means coverage is incomplete.

## Check discovery

`check_discovery` contains:

- `complete`: whether all candidates within policy limits were considered;
- `source`: currently `current_worktree`;
- `scope_matches_diff`: true for worktree scans and false for staged/range scans;
- `candidates_seen`, `checks_returned`, and `limit`;
- `truncated`: whether the check-count limit shortened the returned plan.

For staged and range scans, plans are advisory because manifest discovery describes the current worktree, not necessarily the selected historical scope.

## Files and findings

Each file records `path`, legacy-compatible `status`, `change_status`, `content_kind`, `added_lines`, and `deleted_lines`. Renames may include `old_path`; policy accounting may include `excluded_by` where applicable. Consumers should prefer the separate `change_status` and `content_kind` fields because binary content must not erase whether the underlying Git change was added, modified, deleted, renamed, or untracked.

Each finding includes:

- identity and adjudication: `rule_id`, `severity`, `disposition`, and `confidence`;
- location and context: `path`, nullable `line`, and `context`;
- explanation: `message`, `rationale`, `occurrences`, and `remediation`;
- safe evidence: `evidence_redacted` and a non-secret `fingerprint`.

Do not attempt to reconstruct a detected credential from redacted evidence or fingerprints.

## Check plans and results

Each check contains its exact `id`, `category`, repository-relative `cwd`, argv array, discovery source, manifest fingerprint, required flag, authorization state, and result fields. `status` is one of `not_run`, `passed`, `failed`, `timed_out`, or `unavailable`.

Command IDs are authorization capabilities for one exact repository state and policy. Do not persist them as stable job identifiers. A source, manifest, configuration, canonical-path, or diff-fingerprint change can invalidate them.

`stdout_tail` and `stderr_tail` are nullable, bounded, redacted tails rather than complete logs. `output_truncated` tells consumers when capture exceeded the configured limit. Redaction is defense in depth; do not publish output from a private repository without reviewing it.

## Consumer checklist

1. Reject an unexpected `schema_version`.
2. Tolerate unknown additive fields.
3. Treat `inconclusive` and incomplete coverage as non-ready.
4. Reconcile the file counters and inspect diagnostics.
5. Distinguish finding `disposition` from severity.
6. Display exact `id`, `cwd`, and `argv` before requesting check execution.
7. Never reuse approved command IDs after repository or policy state changes.
8. Preserve redaction and avoid logging private report contents by default.
