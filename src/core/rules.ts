import { createHash } from 'node:crypto'
import { minimatch } from 'minimatch'
import type { DiffSnapshot, Disposition, Finding, FindingContext, GuardianConfig, Severity } from './types.js'

export interface RuleInfo {
  id: string
  title: string
  severity: Severity
  disposition: Disposition
  remediation: string
}

export const RULES: readonly RuleInfo[] = [
  { id: 'RG001', title: 'High-confidence credential token', severity: 'critical', disposition: 'block', remediation: 'Revoke the credential, remove it from the change, and use a secret manager.' },
  { id: 'RG002', title: 'Private key material', severity: 'critical', disposition: 'block', remediation: 'Remove and rotate the private key; load it from an approved secret store.' },
  { id: 'RG003', title: 'Probable secret assignment', severity: 'high', disposition: 'review', remediation: 'Replace the literal with a runtime secret reference and verify that it is synthetic if intentional.' },
  { id: 'RG004', title: 'Embedded URL or bearer credential', severity: 'critical', disposition: 'block', remediation: 'Remove the embedded credential and inject it securely at runtime.' },
  { id: 'RG005', title: 'Sensitive file added', severity: 'high', disposition: 'review', remediation: 'Confirm the file contains no credentials and is safe to version.' },
  { id: 'RG101', title: 'Dependency manifest or lockfile changed', severity: 'medium', disposition: 'review', remediation: 'Review dependency provenance and the resolved lockfile changes.' },
  { id: 'RG102', title: 'Package lifecycle script changed', severity: 'high', disposition: 'review', remediation: 'Review install-time script behavior before dependencies are installed.' },
  { id: 'RG103', title: 'Downloaded or encoded content executed', severity: 'critical', disposition: 'block', remediation: 'Replace download-and-execute behavior with a pinned, verified artifact flow.' },
  { id: 'RG201', title: 'Broad CI write permissions', severity: 'high', disposition: 'review', remediation: 'Grant only the narrowly required workflow permissions.' },
  { id: 'RG202', title: 'Untrusted pull request workflow risk', severity: 'critical', disposition: 'block', remediation: 'Avoid exposing secrets or privileged checkout behavior to untrusted pull requests.' },
  { id: 'RG203', title: 'Workflow action uses a floating reference', severity: 'medium', disposition: 'review', remediation: 'Pin third-party actions to a reviewed immutable commit SHA.' },
  { id: 'RG204', title: 'Release or deployment configuration changed', severity: 'high', disposition: 'review', remediation: 'Require a human review of registry, publishing, and deployment changes.' },
  { id: 'RG301', title: 'TLS verification disabled', severity: 'critical', disposition: 'block', remediation: 'Restore certificate verification and configure the trust store correctly.' },
  { id: 'RG302', title: 'Shell execution entry point added', severity: 'high', disposition: 'review', remediation: 'Use argv-based process execution and strictly validate all inputs.' },
  { id: 'RG303', title: 'Dynamic code evaluation added', severity: 'high', disposition: 'review', remediation: 'Remove dynamic evaluation or constrain it to a reviewed, non-user-controlled input.' },
  { id: 'RG304', title: 'Privilege or host-boundary weakening', severity: 'critical', disposition: 'block', remediation: 'Remove broad privileges, world-writable modes, and sensitive host mounts.' },
  { id: 'RG305', title: 'Destructive operation added', severity: 'high', disposition: 'review', remediation: 'Add narrow targeting, backups, dry-run support, and an explicit approval gate.' },
  { id: 'RG306', title: 'Authentication or access policy weakened', severity: 'high', disposition: 'review', remediation: 'Restore least-privilege access and verify authentication remains enforced.' },
  { id: 'RG401', title: 'Tests removed', severity: 'medium', disposition: 'review', remediation: 'Confirm equivalent coverage remains and explain the test removal.' },
  { id: 'RG402', title: 'Test skipped or disabled', severity: 'medium', disposition: 'review', remediation: 'Re-enable the test or document a time-bounded reason and owner.' },
  { id: 'RG403', title: 'Schema, migration, or public API changed', severity: 'medium', disposition: 'review', remediation: 'Review compatibility, rollback, and migration ordering.' },
  { id: 'RG404', title: 'Binary content could not be scanned', severity: 'medium', disposition: 'review', remediation: 'Inspect the binary artifact and verify its provenance.' },
  { id: 'RG405', title: 'Scan was truncated', severity: 'high', disposition: 'review', remediation: 'Raise the configured limits or narrow the change, then run a complete scan.' },
] as const

const RULE_BY_ID = new Map(RULES.map(rule => [rule.id, rule]))
const MANDATORY_RULES = new Set(['RG001', 'RG002', 'RG003', 'RG004', 'RG005'])

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function isExcluded(path: string, config: GuardianConfig): boolean {
  return config.exclude.some(pattern => minimatch(path, pattern, { dot: true }))
}

function isGenerated(path: string, config: GuardianConfig): boolean {
  return config.generated.some(pattern => minimatch(path, pattern, { dot: true }))
}

function finding(
  ruleId: string,
  path: string,
  line: number | null,
  evidence: string,
  message?: string,
  secretValue?: string,
  options: {
    severity?: Severity
    disposition?: Disposition
    confidence?: Finding['confidence']
    context?: FindingContext
    rationale?: string[]
  } = {},
): Finding {
  const rule = RULE_BY_ID.get(ruleId)
  if (rule === undefined) throw new Error(`unknown rule ${ruleId}`)
  return {
    ruleId,
    severity: options.severity ?? rule.severity,
    disposition: options.disposition ?? rule.disposition,
    confidence: options.confidence ?? 'high',
    context: options.context ?? 'production',
    rationale: options.rationale ?? [`deterministic match for ${ruleId}`],
    occurrences: 1,
    path,
    line,
    message: message ?? rule.title,
    evidenceRedacted: evidence.slice(0, 240),
    fingerprint: sha256(secretValue ?? `${ruleId}\0${path}\0${String(line)}\0${evidence}`),
    remediation: rule.remediation,
  }
}

const PLACEHOLDERS = /^(?:example|sample|test|dummy|changeme|replace[_-]?me|your[_-]?(?:token|key|secret)|<[^>]+>|\$\{[^}]+\})$/i

function looksSynthetic(value: string): boolean {
  const normalized = value.trim().replace(/^['"]|['"]$/g, '')
  if (PLACEHOLDERS.test(normalized)) return true
  if (/^\$[A-Z][A-Z0-9_]+$/.test(normalized)) return true
  if (/^[A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS)$/.test(normalized)) return true
  if (/^(?:gcp-vertex-credentials|tid=test;)|(?:example|realisticlooking|not[-_]?a[-_]?real|for[-_]?tests?)/i.test(normalized)) return true
  if (/^(?:test|fake|dummy|sample|example|mock|your|replace|refreshed|expired|old|new)(?:[-_].+)+$/i.test(normalized)) return true
  if (/(?:^|[-_])(?:test|fake|dummy|sample|example|mock|different|refreshed|expired)(?:[-_]|$)/i.test(normalized)) return true
  return /^(?:x+|0+|\*+)$/i.test(normalized)
}

interface SecretPattern {
  label: string
  regex: RegExp
}

const STRONG_SECRETS: readonly SecretPattern[] = [
  { label: 'AWS access key', regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { label: 'GitHub token', regex: /\b(?:gh[pousr]_[A-Za-z0-9]{30,255}|github_pat_[A-Za-z0-9_]{50,255})\b/g },
  { label: 'Slack token', regex: /\bxox[baprs]-[A-Za-z0-9-]{20,200}\b/g },
  { label: 'Stripe live secret key', regex: /\bsk_live_[A-Za-z0-9]{20,200}\b/g },
  { label: 'Google API key', regex: /\bAIza[A-Za-z0-9_-]{35}\b/g },
]

function scanSecretLine(path: string, line: number, text: string): Finding[] {
  const results: Finding[] = []
  for (const pattern of STRONG_SECRETS) {
    pattern.regex.lastIndex = 0
    for (const match of text.matchAll(pattern.regex)) {
      const value = match[0]
      if (looksSynthetic(value)) continue
      results.push(finding('RG001', path, line, `${pattern.label} literal (${String(value.length)} characters; redacted)`, undefined, value))
    }
  }
  if (/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/.test(text)) {
    const marker = /-----BEGIN [^-]+PRIVATE KEY-----/.exec(text)?.[0] ?? 'private key header'
    results.push(finding('RG002', path, line, 'private key header (redacted)', undefined, marker))
  }
  const bearer = /\bBearer\s+([A-Za-z0-9._~+\/-]{20,})\b/gi.exec(text)
  if (bearer?.[1] !== undefined && !looksSynthetic(bearer[1])) {
    results.push(finding('RG004', path, line, `Bearer credential (${String(bearer[1].length)} characters; redacted)`, undefined, bearer[1]))
  }
  const urlCredential = /\b[a-z][a-z0-9+.-]*:\/\/([^\s:@/]{2,}):([^\s@/]{4,})@/i.exec(text)
  if (urlCredential?.[0] !== undefined && !looksSynthetic(urlCredential[2] ?? '')) {
    results.push(finding('RG004', path, line, 'URL with embedded credentials (redacted)', undefined, urlCredential[0]))
  }
  const assignment = /\b(?:password|passwd|token|secret|api[_-]?key)\b\s*[:=]\s*['"]([^'"\s]{12,})['"]/i.exec(text)
  if (assignment?.[1] !== undefined && !looksSynthetic(assignment[1])) {
    const unique = new Set(assignment[1]).size
    if (unique >= 6) results.push(finding('RG003', path, line, `probable secret assignment (${String(assignment[1].length)} characters; redacted)`, undefined, assignment[1]))
  }
  return results
}

function redactEvidence(text: string): string {
  let redacted = text
  for (const pattern of STRONG_SECRETS) {
    pattern.regex.lastIndex = 0
    redacted = redacted.replace(pattern.regex, `[REDACTED ${pattern.label}]`)
  }
  redacted = redacted
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]{20,}\b/gi, '$1[REDACTED]')
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]{2,}:[^\s@/]{4,}@/gi, '$1[REDACTED]@')
    .replace(/(\b(?:password|passwd|token|secret|api[_-]?key)\b\s*[:=]\s*['"])[^'"\s]{12,}(['"])/gi, '$1[REDACTED]$2')
  return redacted
}

function compactEvidence(text: string): string {
  return redactEvidence(text).trim().replace(/\s+/g, ' ').slice(0, 220)
}

function lineFindings(path: string, line: number, text: string, context: FindingContext): Finding[] {
  const results = scanSecretLine(path, line, text)
  const add = (id: string, test: boolean, message?: string): void => {
    if (test) results.push(finding(id, path, line, compactEvidence(text), message))
  }
  const workflow = /^\.github\/workflows\/.*\.ya?ml$/i.test(path)
  const packageManifest = /(^|\/)package\.json$/.test(path)
  add('RG102', packageManifest && /"(?:preinstall|install|postinstall|prepare)"\s*:/.test(text))
  add('RG103', /(?:curl|wget)\b[^|;&]*(?:\||&&|;)\s*(?:sh|bash|zsh|node|python)\b|base64\s+(?:--decode|-d)\b[^|;&]*(?:\||&&|;)\s*(?:sh|bash|node|python)/i.test(text))
  add('RG201', workflow && /permissions\s*:\s*write-all|(?:contents|packages|actions|id-token|pull-requests)\s*:\s*write\b/i.test(text))
  add('RG202', workflow && (/pull_request_target\s*:/.test(text) || /(?:secrets\.|\$\{\{\s*secrets\.)/.test(text) && /pull_request|head_ref|github\.event\.pull_request/i.test(text)))
  add('RG203', workflow && /\buses\s*:\s*[^\s#]+@(?:main|master|latest|HEAD)\b/i.test(text))
  add('RG301', /(?:rejectUnauthorized|verify|verify_ssl|ssl_verify|tls_verify)\s*[:=]\s*(?:false|False|0)|NODE_TLS_REJECT_UNAUTHORIZED\s*[:=]\s*['"]?0|curl\s+[^\n]*(?:-k|--insecure)\b/i.test(text))
  add('RG302', /\bshell\s*=\s*True\b|\bos\.system\s*\(|\bchild_process\.(?:exec|execSync)\s*\(|\bRuntime\.getRuntime\(\)\.exec\s*\(/.test(text))
  add('RG303', /(?:^|[^\w.])eval\s*\(|\bnew\s+Function\s*\(|\bScriptEngineManager\b/.test(text)
    || (/\.py$/i.test(path) && /(?:^|[^\w.])exec\s*\(/.test(text)))
  add('RG304', /\bchmod\s+(?:-R\s+)?777\b|\bsudo\b|\bprivileged\s*:\s*true\b|\/var\/run\/docker\.sock\s*:|\bsetuid\s*\(/i.test(text))
  add('RG305', /\brm\s+-rf\b|\bDROP\s+(?:DATABASE|TABLE)\b|\bgit\s+push\b[^\n]*(?:--force|-f\b)|\bterraform\s+destroy\b/i.test(text))
  add('RG306', /Access-Control-Allow-Origin\s*[:=]\s*['"]?\*|\bcors\s*\(\s*\)|\bauth\w*\s*[:=]\s*(?:false|disabled)|Effect\s*:\s*['"]Allow['"][^\n]*Resource\s*:\s*['"]\*['"]/i.test(text))
  const skipAdded = /\.(?:[cm]?[jt]sx?)$/i.test(path)
    ? /\b(?:describe|it|test)\.skip\s*\(|\bx(?:it|describe)\s*\(/.test(text)
    : /\.(?:java|kt|kts)$/i.test(path)
      ? /@Disabled\b/.test(text)
      : /\.py$/i.test(path)
        ? /pytest\.mark\.skip\b/.test(text)
        : /\.rs$/i.test(path) && /#\[ignore\]/.test(text)
  add('RG402', skipAdded)
  return results.flatMap(item => {
    const adjudicated = adjudicateFinding(item, text, context)
    return adjudicated === null ? [] : [adjudicated]
  })
}

function isSensitivePath(path: string): boolean {
  const name = path.toLowerCase()
  return /(^|\/)(?:\.env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)|credentials?(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|.*\.(?:pem|p12|pfx|jks|keystore))$/.test(name)
}

function isDependencyPath(path: string): boolean {
  return /(^|\/)(?:package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|pyproject\.toml|poetry\.lock|Pipfile(?:\.lock)?|requirements[^/]*\.txt|go\.(?:mod|sum)|Cargo\.(?:toml|lock)|pom\.xml|build\.gradle(?:\.kts)?|packages\.lock\.json)$/.test(path)
}

function isReleasePath(path: string): boolean {
  return /(^|\/)(?:\.release-guardian\.ya?ml|\.github\/workflows\/[^/]*(?:release|publish|deploy)[^/]*\.ya?ml|Dockerfile|docker-compose[^/]*\.ya?ml|\.npmrc|\.pypirc|Chart\.yaml|.*\.(?:tf|hcl))$/i.test(path)
}

function isSchemaPath(path: string): boolean {
  return /(^|\/)(?:migrations?|schema|openapi|public-api)(?:\/|\.|$)|\.(?:sql|proto)$|openapi\.ya?ml$/i.test(path)
}

function isTestPath(path: string): boolean {
  return /(^|\/)(?:test|tests|__tests__)(?:\/|$)|(?:^|\/)[^/]*(?:\.test|\.spec|_test)\.[^/]+$/i.test(path)
}

function findingContext(path: string, config: GuardianConfig): FindingContext {
  if (isGenerated(path, config)) return 'generated'
  if (/(^|\/)\.github\/workflows\/.*\.ya?ml$/i.test(path)) return 'ci'
  if (/(^|\/)(?:fixtures?|testdata|__snapshots__)(?:\/|$)/i.test(path)) return 'fixture'
  if (isTestPath(path)) return 'test'
  if (/(^|\/)(?:docs?|documentation)(?:\/|$)|(^|\/)README(?:\.[^/]*)?$|\.(?:md|mdx|rst|adoc)$/i.test(path)) return 'documentation'
  if (/(^|\/)examples?(?:\/|$)/i.test(path)) return 'example'
  if (isDependencyPath(path) || /(^|\/)\.npmrc$/i.test(path)) return 'dependency'
  return 'production'
}

const OPERATIONAL_RULES = new Set(['RG103', 'RG301', 'RG302', 'RG303', 'RG304', 'RG305', 'RG306'])

function clearlyInertEvidence(text: string, context: FindingContext): boolean {
  const trimmed = text.trim()
  if (context === 'fixture') return true
  if (/^(?:[-*#>|]|\/\/|\/\*|\*)\s*/.test(trimmed)) return true
  return /\b(?:expect|assert|assertEquals|isSafeCommand)\s*\(|\.toBe\s*\(|\.includes\s*\(|\.match\s*\(\s*\//.test(text)
}

function safeCleanupTarget(text: string): boolean {
  if (/\bsudo\b|\.\.|\$\{|\$[A-Za-z_]|--no-preserve-root/.test(text)) return false
  return /\brm\s+-rf\s+(?:--\s+)?["']?(?:\.\/)?(?:dist|build|coverage|\.cache|out|target)(?:\/[A-Za-z0-9._/-]+)?["']?(?=\s|[,;}]|$)/i.test(text)
}

function destructiveRootTarget(text: string): boolean {
  return /\brm\s+-rf\s+(?:--no-preserve-root\s+)?["']?(?:\/|~|\$HOME|\$\{HOME\}|\.\.?)(?:["']?(?:\s|[,;}]|$)|\/\*)/i.test(text)
}

function adjudicateFinding(item: Finding, text: string, context: FindingContext): Finding | null {
  const rationale = [...item.rationale, `file context: ${context}`]
  let result: Finding = { ...item, context, rationale }

  if (item.ruleId === 'RG003' && ['test', 'fixture', 'documentation', 'example', 'generated'].includes(context)) {
    result = { ...result, severity: 'medium', confidence: 'medium', disposition: 'review', rationale: [...rationale, 'generic secret literal in non-production context; authenticity is uncertain'] }
  }

  if (OPERATIONAL_RULES.has(item.ruleId) && clearlyInertEvidence(text, context)) return null

  if (item.ruleId === 'RG305') {
    if (destructiveRootTarget(text)) {
      return { ...result, severity: 'critical', confidence: 'high', disposition: 'block', rationale: [...rationale, 'destructive command targets a root, home, or parent boundary'] }
    }
    if (safeCleanupTarget(text)) {
      return { ...result, severity: 'low', confidence: 'high', disposition: 'inform', rationale: [...rationale, 'cleanup is limited to a conventional relative build artifact directory'] }
    }
  }

  if (context === 'documentation') {
    if (item.ruleId === 'RG103') {
      return { ...result, severity: 'high', confidence: 'medium', disposition: 'review', rationale: [...rationale, 'copyable documentation command remains actionable but is not executed by the repository'] }
    }
    if (OPERATIONAL_RULES.has(item.ruleId)) {
      return { ...result, severity: 'low', confidence: 'medium', disposition: 'inform', rationale: [...rationale, 'operational text appears in documentation'] }
    }
  }

  if ((context === 'test' || context === 'example') && OPERATIONAL_RULES.has(item.ruleId)) {
    result = { ...result, severity: item.severity === 'critical' ? 'high' : item.severity, disposition: 'review', confidence: 'medium', rationale: [...rationale, 'operational pattern is in non-production code and requires reachability review'] }
  }

  if (item.ruleId === 'RG304' && /\bsudo\b/i.test(text)
    && !/\b(?:privileged\s*:\s*true|setuid\s*\(|chmod\s+(?:-R\s+)?777|rm\s+-rf)\b/i.test(text)
    && !/\/var\/run\/docker\.sock\s*:/.test(text)) {
    const routineCiInstall = context === 'ci' && /\bsudo\s+(?:apt-get|apt|dnf|yum|brew)\b/i.test(text)
    return {
      ...result,
      severity: routineCiInstall ? 'medium' : 'high',
      disposition: 'review',
      confidence: 'high',
      rationale: [...rationale, routineCiInstall ? 'package installation uses runner privilege in CI' : 'sudo use requires review but is not by itself a host-boundary bypass'],
    }
  }

  if (item.ruleId === 'RG202' && /pull_request_target\s*:/.test(text)) {
    return { ...result, severity: 'high', disposition: 'review', rationale: [...rationale, 'pull_request_target alone is a risk prerequisite, not proof of untrusted code execution'] }
  }

  return result
}

function adjudicateFileFinding(item: Finding): Finding {
  if (item.ruleId === 'RG404' && /\.(?:png|jpe?g|gif|webp|ico|pdf)$/i.test(item.path)) {
    return {
      ...item,
      severity: 'low',
      disposition: 'inform',
      rationale: [...item.rationale, 'opaque media asset requires provenance tracking but is not executable'],
    }
  }
  if (item.ruleId === 'RG101' && item.context === 'example') {
    return {
      ...item,
      severity: 'low',
      disposition: 'inform',
      rationale: [...item.rationale, 'dependency metadata belongs to an example package'],
    }
  }
  if (item.ruleId === 'RG403' && ['test', 'fixture', 'example'].includes(item.context)) {
    return {
      ...item,
      severity: 'low',
      disposition: 'inform',
      rationale: [...item.rationale, 'schema or migration path is non-production test/example material'],
    }
  }
  return item
}

function aggregateFindings(items: readonly Finding[]): Finding[] {
  const aggregateRules = new Set(['RG304', 'RG305', 'RG402'])
  const aggregated = new Map<string, Finding>()
  for (const item of items) {
    const key = aggregateRules.has(item.ruleId)
      ? `${item.path}\0${item.ruleId}\0${item.severity}\0${item.disposition}\0${item.context}`
      : `${item.path}\0${String(item.line)}\0${item.ruleId}\0${item.fingerprint}`
    const previous = aggregated.get(key)
    if (previous === undefined) {
      aggregated.set(key, item)
      continue
    }
    const fingerprints = [previous.fingerprint, item.fingerprint].sort()
    aggregated.set(key, {
      ...previous,
      line: previous.line === null ? item.line : item.line === null ? previous.line : Math.min(previous.line, item.line),
      occurrences: previous.occurrences + item.occurrences,
      fingerprint: sha256(fingerprints.join('\0')),
      rationale: [...new Set([...previous.rationale, `aggregated ${String(previous.occurrences + item.occurrences)} matching occurrences in this file`])],
    })
  }
  return [...aggregated.values()]
}

export interface ScanResult {
  findings: Finding[]
  diagnostics: string[]
}

export function scanDiff(snapshot: DiffSnapshot, config: GuardianConfig): ScanResult {
  const findings = new Map<string, Finding>()
  const diagnostics: string[] = []
  let findingLimitReached = false
  const severityRank: Record<Severity, number> = { critical: 5, high: 4, medium: 3, low: 2, info: 1 }
  const dispositionRank: Record<Disposition, number> = { block: 3, review: 2, inform: 1 }
  const keyOf = (item: Finding): string => {
    const secretRule = ['RG001', 'RG002', 'RG003', 'RG004'].includes(item.ruleId)
    return secretRule
      ? `${item.path}\0${String(item.line)}\0${item.fingerprint}`
      : `${item.path}\0${String(item.line)}\0${item.ruleId}\0${item.fingerprint}`
  }
  const priorityOf = (item: Finding): number => dispositionRank[item.disposition] * 10 + severityRank[item.severity]
  const pathStates = new Map<string, { context: FindingContext; excluded: boolean; linePolicyExcluded: boolean }>()
  const stateFor = (path: string): { context: FindingContext; excluded: boolean; linePolicyExcluded: boolean } => {
    const cached = pathStates.get(path)
    if (cached !== undefined) return cached
    const excluded = isExcluded(path, config)
    const state = { context: findingContext(path, config), excluded, linePolicyExcluded: excluded || isGenerated(path, config) }
    pathStates.set(path, state)
    return state
  }
  const push = (item: Finding): void => {
    const key = keyOf(item)
    const previous = findings.get(key)
    if (previous !== undefined) {
      if (priorityOf(item) > priorityOf(previous)) findings.set(key, item)
      return
    }
    if (findings.size < config.maxFindings) {
      findings.set(key, item)
      return
    }
    findingLimitReached = true
    let lowest: [string, Finding] | undefined
    for (const entry of findings.entries()) {
      if (lowest === undefined || priorityOf(entry[1]) < priorityOf(lowest[1])) lowest = entry
    }
    if (lowest !== undefined && priorityOf(item) > priorityOf(lowest[1])) {
      findings.delete(lowest[0])
      findings.set(key, item)
    }
  }
  for (const file of snapshot.files) {
    const { excluded: policyExcluded, context } = stateFor(file.path)
    const fileFinding = (ruleId: string, evidence: string): Finding => adjudicateFileFinding(finding(
      ruleId,
      file.path,
      null,
      evidence,
      undefined,
      undefined,
      { context, rationale: [`file metadata match for ${ruleId}`, `file context: ${context}`] },
    ))
    if ((file.status === 'added' || file.status === 'untracked') && isSensitivePath(file.path)) push(fileFinding('RG005', 'sensitive filename'))
    const policyConfiguration = /(^|\/)\.release-guardian\.ya?ml$/i.test(file.path)
    if (policyConfiguration) push(fileFinding('RG204', 'release policy configuration changed'))
    if (policyExcluded) continue
    if (isDependencyPath(file.path)) push(fileFinding('RG101', 'dependency manifest or lockfile changed'))
    if (!policyConfiguration && isReleasePath(file.path)) push(fileFinding('RG204', 'release, registry, container, or deployment file changed'))
    if (isSchemaPath(file.path)) push(fileFinding('RG403', 'schema, migration, or public API file changed'))
    if (file.status === 'binary') push(fileFinding('RG404', 'binary content was not inspected'))
    if (file.status === 'deleted' && isTestPath(file.path)) push(fileFinding('RG401', 'test file deleted'))
    else if (isTestPath(file.path) && file.deletedLines >= 20) push(fileFinding('RG401', `${String(file.deletedLines)} test lines deleted`))
  }
  for (const added of snapshot.addedLines) {
    const { linePolicyExcluded: policyExcluded, context } = stateFor(added.path)
    for (const item of lineFindings(added.path, added.line, added.text, context)) {
      if (policyExcluded && item.disposition !== 'block' && !MANDATORY_RULES.has(item.ruleId)) continue
      push(item)
    }
  }
  if (snapshot.truncated || findingLimitReached) {
    const truncation = finding('RG405', '.', null, 'scan input or finding output limit reached')
    const truncationKey = keyOf(truncation)
    if (!findings.has(truncationKey)) {
      if (findings.size < config.maxFindings) findings.set(truncationKey, truncation)
      else {
        const replaceable = [...findings.entries()]
          .filter(([, item]) => item.disposition !== 'block')
          .sort((left, right) => priorityOf(left[1]) - priorityOf(right[1]))[0]
        if (replaceable !== undefined) {
          findings.delete(replaceable[0])
          findings.set(truncationKey, truncation)
        }
      }
    }
    diagnostics.push('the scan did not inspect or report every candidate; verdict is fail-closed')
  }
  return {
    findings: aggregateFindings([...findings.values()]).sort((a, b) => a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0) || a.ruleId.localeCompare(b.ruleId)),
    diagnostics,
  }
}

export function getRule(ruleId: string): RuleInfo | undefined {
  return RULE_BY_ID.get(ruleId)
}
