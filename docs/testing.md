# Testing and verification

## Local quality gate

Use a supported Node.js version and install exactly from the lockfile:

```sh
npm ci
npm run check
npm audit --omit=dev --audit-level=high
npm run pack:check
```

`npm run check` runs TypeScript typechecking, a production/Codex-runner build, the Vitest suite, package verification, `publint`, and the pack check. `npm run pack:check` builds and inspects the release artifact in an isolated temporary directory; it is the quickest way to catch missing packaged files or a broken packaged CLI.

After a build, scan this checkout without executing its discovered project checks:

```sh
npm run guardian:self
```

## Test areas

| Area | Representative suite | Expected coverage |
| --- | --- | --- |
| Audit orchestration | `tests/audit.spec.ts` | Modes, baseline policy, truncation, authorization binding, and report completeness. |
| Candidate filtering | `tests/candidates.spec.ts` | Risk-relevant line selection without losing required coverage. |
| Configuration | `tests/config.spec.ts` | Strict fields, aliases, defaults, validation, and repository containment. |
| Check discovery | `tests/discovery.spec.ts` | Supported ecosystems, package-manager selection, limits, and safe argv plans. |
| DSH contract | `tests/plugin.spec.ts` | Tool registration, structured output, and run gating. |
| Claude Code plugin | `tests/claude-plugin.spec.ts` | Manifest and marketplace contract, launcher argument/exit-code passthrough, and commit-gate decisions including its disabled and fail-open paths. |
| Package layout | `tests/package-layout.spec.ts` | Release contents, self-contained runner, metadata agreement, and dependency-spec constraints. |
| Rules | `tests/rules.spec.ts` | Dangerous examples, benign near-neighbors, disposition, context, and redaction. |
| Check runner | `tests/runner.spec.ts` | Direct argv execution, status mapping, timeout/output bounds, and redaction. |
| Verdicts | `tests/verdict.spec.ts` | Ready/review/block/inconclusive aggregation. |

## DSH packed-profile smoke test

The real DSH integration uses pnpm `11.19.0` and the exact supported DSH RC:

```sh
corepack enable
corepack prepare pnpm@11.19.0 --activate
npm ci
npm run build
npm run test:dsh
```

The smoke test packs the repository and installs the artifact into an isolated DSH profile. Run it when the bundle patch, package contents, DSH dependencies, or supported RC changes.

## Compatibility matrix

CI runs the regular quality gate on Linux, macOS, and Windows with Node.js `22.19.0` and `24.x`. The DSH packed-profile smoke runs on Linux with Node.js `22.19.0`. A green matrix verifies the scanner itself; discovered language-specific commands still depend on each target repository's toolchains.

## Adding a rule or security-sensitive behavior

Include tests for:

- a dangerous synthetic fixture and a benign near-neighbor;
- severity, confidence, disposition, context, and remediation;
- redacted evidence and output where secrets may appear;
- exclusion/generated policy interaction;
- truncation or other fail-closed behavior when applicable;
- stable JSON schema behavior, preferring additive fields for schema version `1`.

Never place real credentials, private repository data, or unredacted check output in fixtures, issues, or pull requests. Follow [CONTRIBUTING.md](../CONTRIBUTING.md) and [SECURITY.md](../SECURITY.md).
