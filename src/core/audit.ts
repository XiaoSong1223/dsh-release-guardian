import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { parseProjectConfig, resolveConfig, DEFAULT_CONFIG } from './config.js'
import { collectDiff, readTextAtRevision, resolveHeadOrNull, resolveMergeBase, resolveRepositoryRoot } from './git.js'
import { discoverChecksDetailed } from './discovery.js'
import { scanDiff } from './rules.js'
import { executeChecks } from './runner.js'
import { determineVerdict } from './verdict.js'
import { SCHEMA_VERSION, TOOL_VERSION } from './types.js'
import type { AuditRequest, CheckResult, Finding, GuardianConfig, ReleaseReport, Severity } from './types.js'

function summary(findings: readonly Finding[], checks: readonly CheckResult[]): ReleaseReport['summary'] {
  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 }
  for (const item of findings) counts[item.severity] += 1
  return {
    ...counts,
    findingsBlocking: findings.filter(item => item.disposition === 'block').length,
    findingsReview: findings.filter(item => item.disposition === 'review').length,
    findingsInformational: findings.filter(item => item.disposition === 'inform').length,
    checksPassed: checks.filter(check => check.status === 'passed').length,
    checksFailed: checks.filter(check => ['failed', 'timed_out', 'unavailable'].includes(check.status)).length,
    checksNotRun: checks.filter(check => check.status === 'not_run').length,
  }
}

function emptyFailure(request: AuditRequest, started: number, message: string): ReleaseReport {
  const mode = request.mode ?? (request.base === undefined ? 'worktree' : 'range')
  return {
    schemaVersion: SCHEMA_VERSION,
    toolVersion: TOOL_VERSION,
    verdict: { status: 'inconclusive', riskScore: 0, reasons: ['scan-incomplete'] },
    repository: { root: resolve(request.repoPath), head: null, base: request.base ?? null, dirty: false },
    diff: { mode, filesChanged: 0, filesSeen: 0, filesExcluded: 0, filesUnseen: 0, exclusions: [], fingerprint: 'sha256:unavailable', candidateLinesSeen: 0, addedLinesSeen: 0, deletedLinesSeen: 0, truncated: true },
    checkDiscovery: { complete: false, source: 'current_worktree', scopeMatchesDiff: false, candidatesSeen: 0, checksReturned: 0, limit: 0, truncated: false },
    summary: { critical: 0, high: 0, medium: 0, low: 0, info: 0, findingsBlocking: 0, findingsReview: 0, findingsInformational: 0, checksPassed: 0, checksFailed: 0, checksNotRun: 0 },
    files: [],
    findings: [],
    checks: [],
    diagnostics: [`fatal: ${message}`],
    warnings: [],
    durationMs: Date.now() - started,
  }
}

export async function auditRelease(request: AuditRequest, baseConfig: Partial<GuardianConfig> = {}): Promise<ReleaseReport> {
  const started = Date.now()
  try {
    const repoRoot = await resolveRepositoryRoot(request.repoPath, request.signal)
    const mode = request.mode ?? (request.base === undefined ? 'worktree' : 'range')
    const headRef = request.head ?? 'HEAD'
    const requestedConfig = resolve(repoRoot, request.configPath ?? '.release-guardian.yml')
    const configRelativeNative = relative(repoRoot, requestedConfig)
    if (configRelativeNative === '' || isAbsolute(configRelativeNative) || configRelativeNative === '..' || configRelativeNative.startsWith(`..${sep}`)) {
      throw new TypeError('configuration path escapes the repository root or is not a file path')
    }
    const configRelative = configRelativeNative.split(sep).join('/')
    const baselineRef = mode === 'range'
      ? await resolveMergeBase(repoRoot, request.base ?? '', headRef, request.signal)
      : await resolveHeadOrNull(repoRoot, request.signal)
    const baselineConfigText = baselineRef === null
      ? undefined
      : await readTextAtRevision(repoRoot, baselineRef, configRelative, 1024 * 1024, request.signal)
    const project = baselineConfigText === undefined ? undefined : parseProjectConfig(baselineConfigText)
    const config = resolveConfig({ ...DEFAULT_CONFIG, ...baseConfig, workspaceRoot: repoRoot }, project)
    if (request.maxDiffBytes !== undefined) config.maxDiffBytes = request.maxDiffBytes
    if (request.includeUntracked !== undefined) config.includeUntracked = request.includeUntracked
    const snapshot = await collectDiff(repoRoot, {
      mode,
      ...(request.base === undefined ? {} : { base: request.base }),
      head: headRef,
      includeUntracked: config.includeUntracked,
      maxBytes: config.maxDiffBytes,
      maxFiles: config.maxFiles,
      exclude: config.exclude,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })
    const scan = scanDiff(snapshot, config)
    const categories = request.categories ?? ['test', 'typecheck', 'build']
    const discovery = await discoverChecksDetailed(repoRoot, config, categories)
    const authorizationContext = `sha256:${createHash('sha256').update(JSON.stringify({
      repoRoot,
      diffFingerprint: snapshot.fingerprint,
      config: { ...config, workspaceRoot: '.' },
    })).digest('hex')}`
    const plans = discovery.plans.map(plan => ({
      ...plan,
      id: `sha256:${createHash('sha256').update(`${plan.id}\0${authorizationContext}`).digest('hex')}`,
      authorizationContext,
    }))
    const diagnostics = [...snapshot.diagnostics, ...scan.diagnostics, ...discovery.diagnostics]
    const warnings = [...discovery.warnings]
    const discoveryScopeMatchesDiff = mode === 'worktree'
    if (!discoveryScopeMatchesDiff && categories.length > 0) {
      warnings.push(`${mode} diff selected; check discovery reflects the current worktree and is advisory for this scan scope`)
    }
    let incomplete = snapshot.truncated || scan.findings.some(item => item.ruleId === 'RG405') || !discovery.complete
    if (snapshot.files.some(file => file.path === configRelative || file.oldPath === configRelative)) {
      diagnostics.push(`policy configuration changed in the audited diff and was not trusted: ${configRelative}`)
      incomplete = true
    }
    for (const category of config.requiredChecks) {
      if (!plans.some(plan => plan.category === category && plan.required)) {
        diagnostics.push(`required check category could not be discovered: ${category}`)
        incomplete = true
      }
    }
    if (request.runApprovedChecks === true) {
      if (mode !== 'worktree' || !config.includeUntracked) {
        diagnostics.push('check execution requires worktree mode with untracked files included so authorization covers executable repository state')
        incomplete = true
      }
      const currentIds = new Set(plans.map(plan => plan.id))
      for (const approvedId of new Set(request.approvedCommandIds ?? [])) {
        if (!currentIds.has(approvedId)) {
          diagnostics.push(`approved command ID is stale or unknown: ${approvedId}`)
          incomplete = true
        }
      }
    }
    const checks = await executeChecks(
      repoRoot,
      plans,
      config,
      request.runApprovedChecks === true && !incomplete,
      request.approvedCommandIds ?? [],
      request.signal,
    )
    const verdict = determineVerdict(scan.findings, checks, { incomplete, runRequested: request.runApprovedChecks === true })
    const head = await resolveHeadOrNull(repoRoot, request.signal)
    return {
      schemaVersion: SCHEMA_VERSION,
      toolVersion: TOOL_VERSION,
      verdict,
      repository: { root: repoRoot, head, base: snapshot.base, dirty: mode === 'worktree' && snapshot.filesChanged > 0 },
      diff: {
        mode,
        filesChanged: snapshot.filesChanged,
        filesSeen: snapshot.filesSeen,
        filesExcluded: snapshot.filesExcluded,
        filesUnseen: snapshot.filesUnseen,
        exclusions: snapshot.exclusions,
        fingerprint: snapshot.fingerprint,
        candidateLinesSeen: snapshot.candidateLinesSeen,
        addedLinesSeen: snapshot.addedLinesSeen,
        deletedLinesSeen: snapshot.deletedLinesSeen,
        truncated: snapshot.truncated,
      },
      checkDiscovery: {
        complete: discovery.complete,
        source: 'current_worktree',
        scopeMatchesDiff: discoveryScopeMatchesDiff,
        candidatesSeen: discovery.candidatesSeen,
        checksReturned: discovery.checksReturned,
        limit: discovery.limit,
        truncated: discovery.truncated,
      },
      summary: summary(scan.findings, checks),
      files: snapshot.files.filter(file => file.excludedBy === undefined),
      findings: scan.findings,
      checks,
      diagnostics,
      warnings,
      durationMs: Date.now() - started,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return emptyFailure(request, started, message)
  }
}
