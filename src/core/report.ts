import type { ReleaseReport } from './types.js'

export function toJsonReport(report: ReleaseReport): Record<string, unknown> {
  return {
    schema_version: report.schemaVersion,
    tool_version: report.toolVersion,
    verdict: {
      status: report.verdict.status,
      risk_score: report.verdict.riskScore,
      reasons: report.verdict.reasons,
    },
    repository: report.repository,
    diff: {
      mode: report.diff.mode,
      files_changed: report.diff.filesChanged,
      files_seen: report.diff.filesSeen,
      files_excluded: report.diff.filesExcluded,
      files_unseen: report.diff.filesUnseen,
      exclusions: report.diff.exclusions.map(item => ({
        pattern: item.pattern,
        count: item.count,
        sample_paths: item.samplePaths,
      })),
      fingerprint: report.diff.fingerprint,
      candidate_lines_scanned: report.diff.candidateLinesSeen,
      added_lines_seen: report.diff.addedLinesSeen,
      deleted_lines_seen: report.diff.deletedLinesSeen,
      truncated: report.diff.truncated,
    },
    check_discovery: {
      complete: report.checkDiscovery.complete,
      source: report.checkDiscovery.source,
      scope_matches_diff: report.checkDiscovery.scopeMatchesDiff,
      candidates_seen: report.checkDiscovery.candidatesSeen,
      checks_returned: report.checkDiscovery.checksReturned,
      limit: report.checkDiscovery.limit,
      truncated: report.checkDiscovery.truncated,
    },
    summary: {
      critical: report.summary.critical,
      high: report.summary.high,
      medium: report.summary.medium,
      low: report.summary.low,
      info: report.summary.info,
      findings_blocking: report.summary.findingsBlocking,
      findings_review: report.summary.findingsReview,
      findings_informational: report.summary.findingsInformational,
      checks_passed: report.summary.checksPassed,
      checks_failed: report.summary.checksFailed,
      checks_not_run: report.summary.checksNotRun,
    },
    files: report.files.map(file => ({
      path: file.path,
      status: file.status,
      ...(file.changeStatus === undefined ? {} : { change_status: file.changeStatus }),
      ...(file.contentKind === undefined ? {} : { content_kind: file.contentKind }),
      added_lines: file.addedLines,
      deleted_lines: file.deletedLines,
      ...(file.oldPath === undefined ? {} : { old_path: file.oldPath }),
      ...(file.excludedBy === undefined ? {} : { excluded_by: file.excludedBy }),
    })),
    findings: report.findings.map(item => ({
      rule_id: item.ruleId,
      severity: item.severity,
      disposition: item.disposition,
      confidence: item.confidence,
      context: item.context,
      rationale: item.rationale,
      occurrences: item.occurrences,
      path: item.path,
      line: item.line,
      message: item.message,
      evidence_redacted: item.evidenceRedacted,
      fingerprint: item.fingerprint,
      remediation: item.remediation,
    })),
    checks: report.checks.map(check => ({
      id: check.id,
      category: check.category,
      cwd: check.cwd,
      argv: check.argv,
      detected_by: check.detectedBy,
      manifest_fingerprint: check.manifestFingerprint,
      ...(check.authorizationContext === undefined ? {} : { authorization_context: check.authorizationContext }),
      required: check.required,
      authorization: check.authorization,
      status: check.status,
      duration_ms: check.durationMs,
      exit_code: check.exitCode,
      stdout_tail: check.stdoutTail,
      stderr_tail: check.stderrTail,
      output_truncated: check.outputTruncated,
    })),
    diagnostics: report.diagnostics,
    warnings: report.warnings,
    duration_ms: report.durationMs,
  }
}

export function formatJson(report: ReleaseReport): string {
  return `${JSON.stringify(toJsonReport(report), null, 2)}\n`
}

export function formatText(report: ReleaseReport): string {
  const heading: Record<ReleaseReport['verdict']['status'], string> = {
    ready: 'READY — no release-blocking risk found',
    review: 'REVIEW — release needs human attention',
    block: 'BLOCK — release should not proceed',
    inconclusive: 'INCONCLUSIVE — scan or required checks were incomplete',
  }
  const lines = [heading[report.verdict.status], '']
  lines.push(`Risk score: ${String(report.verdict.riskScore)}/100`)
  const exclusionNote = report.diff.filesExcluded === 0 ? '' : `; ${String(report.diff.filesExcluded)} policy-excluded`
  lines.push(`Diff: ${String(report.diff.filesSeen)}/${String(report.diff.filesChanged)} files inspected${exclusionNote}, +${String(report.diff.addedLinesSeen)}/-${String(report.diff.deletedLinesSeen)} lines`)
  lines.push(`Findings: ${String(report.summary.critical)} critical, ${String(report.summary.high)} high, ${String(report.summary.medium)} medium, ${String(report.summary.low)} low`)
  lines.push(`Disposition: ${String(report.summary.findingsBlocking)} block, ${String(report.summary.findingsReview)} review, ${String(report.summary.findingsInformational)} inform`)
  lines.push(`Checks: ${String(report.summary.checksPassed)} passed, ${String(report.summary.checksFailed)} failed, ${String(report.summary.checksNotRun)} not run`)
  const discoveryScope = report.checkDiscovery.scopeMatchesDiff ? 'scope matched' : 'advisory for selected diff'
  lines.push(`Check discovery: ${String(report.checkDiscovery.checksReturned)}/${String(report.checkDiscovery.candidatesSeen)} checks (${report.checkDiscovery.complete ? 'complete' : 'incomplete'}; ${report.checkDiscovery.source}; ${discoveryScope}; limit ${String(report.checkDiscovery.limit)})`)
  if (report.diff.exclusions.length > 0) {
    lines.push('', 'Policy exclusions')
    for (const exclusion of report.diff.exclusions) {
      lines.push(`- ${exclusion.pattern}: ${String(exclusion.count)} file(s); examples: ${exclusion.samplePaths.join(', ')}`)
    }
  }
  if (report.findings.length > 0) {
    lines.push('', 'Findings')
    const dispositionRank = { block: 0, review: 1, inform: 2 } as const
    const severityRank = { critical: 0, high: 1, medium: 2, low: 3, info: 4 } as const
    const displayed = [...report.findings].sort((left, right) =>
      dispositionRank[left.disposition] - dispositionRank[right.disposition]
      || severityRank[left.severity] - severityRank[right.severity]
      || left.path.localeCompare(right.path)
      || (left.line ?? 0) - (right.line ?? 0),
    )
    for (const item of displayed) {
      const location = item.line === null ? item.path : `${item.path}:${String(item.line)}`
      const occurrences = item.occurrences > 1 ? ` x${String(item.occurrences)}` : ''
      lines.push(`${item.severity.toUpperCase()} ${item.ruleId} [${item.context}] ${location}${occurrences}`)
      lines.push(`  ${item.message}. ${item.evidenceRedacted}`)
    }
  }
  if (report.checks.length > 0) {
    lines.push('', 'Check plan')
    for (const check of report.checks) {
      lines.push(`${check.status.toUpperCase()} ${check.id} [${check.category}] ${check.cwd || '.'}`)
      lines.push(`  ${check.argv.map(argument => JSON.stringify(argument)).join(' ')}`)
    }
  }
  if (report.diagnostics.length > 0) {
    lines.push('', 'Diagnostics')
    for (const diagnostic of report.diagnostics) lines.push(`- ${diagnostic}`)
  }
  if (report.warnings.length > 0) {
    lines.push('', 'Warnings')
    for (const warning of report.warnings) lines.push(`- ${warning}`)
  }
  return `${lines.join('\n')}\n`
}
