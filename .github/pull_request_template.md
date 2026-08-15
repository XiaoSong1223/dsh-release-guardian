## Summary

<!-- What changed, and what release risk, false-positive class, or workflow does it address? -->

## Verification

<!-- List the exact commands run and relevant results. -->

- [ ] `npm run check`
- [ ] `npm run pack:check`
- [ ] `npm run test:dsh` when bundle/package/DSH behavior changed
- [ ] Documentation and examples were updated when user-facing behavior changed

## Safety and compatibility

- [ ] Tests cover behavior changes, including a benign near-neighbor for detection changes
- [ ] No real credentials, private repository content, or unredacted check output is included
- [ ] Static scanning remains read-only and project checks still require explicit, current authorization
- [ ] Trusted-baseline policy, repository containment, truncation handling, and redaction are not weakened
- [ ] Schema version `1` changes are additive, or the compatibility impact is explicitly documented
- [ ] CLI, DSH bundle, and optional Codex/Claude Code adapter behavior were considered
- [ ] Any GitHub Action reference added or changed is pinned to a reviewed immutable commit SHA

## Release notes

<!-- Describe the user-visible change, or write "None". -->
