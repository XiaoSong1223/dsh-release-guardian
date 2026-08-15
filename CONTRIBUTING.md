# Contributing

Thanks for helping improve DSH Release Guardian.

## Development

Requirements:

- Node.js `^22.19.0` or `>=24.0.0`
- Git
- pnpm `11.19.0` for the real DSH smoke test

Install dependencies and run the local quality gates:

```sh
npm ci
npm run check
npm audit --omit=dev --audit-level=high
npm run pack:check
npm run test:dsh
```

Keep detection deterministic and local. New rules should include a dangerous fixture, a benign near-neighbor, expected severity, confidence, disposition, redacted evidence, and fail-closed behavior when relevant.

When changing the Claude Code plugin surface, also validate its manifests:

```sh
claude plugin validate .claude-plugin/plugin.json
claude plugin validate .
```

Keep `version` in `.claude-plugin/plugin.json` equal to the `package.json` version; `tests/claude-plugin.spec.ts` enforces that and the rest of the plugin contract.

## Pull requests

- Explain the release risk or false-positive class being addressed.
- Add or update tests for behavior changes.
- Preserve the versioned JSON contract; additive fields are preferred for schema version `1`.
- Do not weaken authorization binding, trusted-baseline policy, output redaction, or truncation handling.
- Do not give a host adapter its own execution path. Adapters may only display a plan and carry explicit user approval into the same CLI or host tool.
- Pin GitHub Actions to reviewed immutable commit SHAs.

## Security reports

Follow [SECURITY.md](./SECURITY.md). Never put a real credential, private repository content, or unredacted command output in a public issue or pull request.
