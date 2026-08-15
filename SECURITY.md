# Security policy

## Supported versions

Security fixes are applied to the latest `0.1.x` release while the plugin and DeepSeek Harness remain in developer preview. Compatibility is tested against the exact DSH release candidate documented in the README.

## Reporting a vulnerability

Use GitHub's private security-advisory flow for `XiaoSong1223/dsh-release-guardian` when available. Do not open a public issue containing a real credential, private repository content, or unredacted check output.

Include the affected version, operating system, Node version, diff mode, minimal redacted reproduction, expected behavior, and observed behavior. Replace all credentials with synthetic markers that preserve only the relevant shape.

The following are security-sensitive:

- bypassing a blocking rule through exclusions, generated-file policy, truncation, or configuration changes;
- executing a command without an exact, current authorization ID;
- command-ID reuse after repository or effective-policy changes;
- repository escape through paths, symlinks, configuration, or check working directories;
- disclosure of credentials through findings, diagnostics, JSON, text output, or check-output tails;
- shell interpretation of an argv plan that should execute without a shell.

Rule-coverage gaps and false positives without a security-boundary bypass may be reported as ordinary issues, using synthetic examples only.

## Operational boundary

Static discovery is read-only with respect to the target repository. Explicitly approved project checks execute without a sandbox and may read or write with the invoking user's permissions. Offline and reduced-environment controls are defense in depth, not a filesystem or network boundary.
