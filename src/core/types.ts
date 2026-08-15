export const SCHEMA_VERSION = '1' as const
export const TOOL_VERSION = '0.1.0' as const

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info'
export type Disposition = 'block' | 'review' | 'inform'
export type VerdictStatus = 'ready' | 'review' | 'block' | 'inconclusive'
export type DiffMode = 'worktree' | 'staged' | 'range'
export type CheckCategory = 'test' | 'typecheck' | 'build'
export type CheckStatus = 'not_run' | 'passed' | 'failed' | 'timed_out' | 'unavailable'
export type FindingContext = 'production' | 'ci' | 'dependency' | 'test' | 'fixture' | 'documentation' | 'example' | 'generated'

export interface Finding {
  ruleId: string
  severity: Severity
  disposition: Disposition
  confidence: 'high' | 'medium' | 'low'
  context: FindingContext
  rationale: string[]
  occurrences: number
  path: string
  line: number | null
  message: string
  evidenceRedacted: string
  fingerprint: string
  remediation: string
}

export interface ChangedFile {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'binary' | 'untracked'
  changeStatus?: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'
  contentKind?: 'text' | 'binary' | 'uninspected'
  addedLines: number
  deletedLines: number
  oldPath?: string
  excludedBy?: string
}

export interface ExclusionSummary {
  pattern: string
  count: number
  samplePaths: string[]
}

export interface AddedLine {
  path: string
  line: number
  text: string
}

export interface DiffSnapshot {
  mode: DiffMode
  base: string | null
  head: string
  files: ChangedFile[]
  addedLines: AddedLine[]
  filesChanged: number
  filesSeen: number
  filesExcluded: number
  filesUnseen: number
  exclusions: ExclusionSummary[]
  fingerprint: string
  candidateLinesSeen: number
  addedLinesSeen: number
  deletedLinesSeen: number
  truncated: boolean
  diagnostics: string[]
}

export interface CheckPlan {
  id: string
  category: CheckCategory
  cwd: string
  argv: string[]
  detectedBy: string
  required: boolean
  manifestFingerprint: string
  authorizationContext?: string
  timeoutMs?: number
}

export interface CheckResult extends CheckPlan {
  authorization: 'required' | 'approved'
  status: CheckStatus
  durationMs: number | null
  exitCode: number | null
  stdoutTail: string | null
  stderrTail: string | null
  outputTruncated: boolean
}

export interface Verdict {
  status: VerdictStatus
  riskScore: number
  reasons: string[]
}

export interface ReleaseReport {
  schemaVersion: typeof SCHEMA_VERSION
  toolVersion: typeof TOOL_VERSION
  verdict: Verdict
  repository: {
    root: string
    head: string | null
    base: string | null
    dirty: boolean
  }
  diff: {
    mode: DiffMode
    filesChanged: number
    filesSeen: number
    filesExcluded: number
    filesUnseen: number
    exclusions: ExclusionSummary[]
    fingerprint: string
    candidateLinesSeen: number
    addedLinesSeen: number
    deletedLinesSeen: number
    truncated: boolean
  }
  checkDiscovery: {
    complete: boolean
    source: 'current_worktree'
    scopeMatchesDiff: boolean
    candidatesSeen: number
    checksReturned: number
    limit: number
    truncated: boolean
  }
  summary: {
    critical: number
    high: number
    medium: number
    low: number
    info: number
    findingsBlocking: number
    findingsReview: number
    findingsInformational: number
    checksPassed: number
    checksFailed: number
    checksNotRun: number
  }
  files: ChangedFile[]
  findings: Finding[]
  checks: CheckResult[]
  diagnostics: string[]
  warnings: string[]
  durationMs: number
}

export interface AuditRequest {
  repoPath: string
  configPath?: string
  mode?: DiffMode
  base?: string
  head?: string
  includeUntracked?: boolean
  maxDiffBytes?: number
  categories?: CheckCategory[]
  approvedCommandIds?: string[]
  runApprovedChecks?: boolean
  signal?: AbortSignal
}

export interface GuardianConfig {
  workspaceRoot: string
  maxDiffBytes: number
  maxFiles: number
  maxFindings: number
  maxCheckOutputBytes: number
  checkTimeoutMs: number
  includeUntracked: boolean
  manifestDepth: number
  maxChecks: number
  exclude: string[]
  generated: string[]
  requiredChecks: CheckCategory[]
  commands: ConfiguredCommand[]
}

export interface ConfiguredCommand {
  id: string
  category: CheckCategory
  cwd: string
  argv: string[]
  required: boolean
  timeoutMs?: number
}

export interface ProjectConfigFile {
  version: 1
  diff?: {
    includeUntracked?: boolean
    include_untracked?: boolean
    maxBytes?: number
    max_bytes?: number
    exclude?: string[]
    generated?: string[]
  }
  checks?: {
    required?: CheckCategory[]
    discover?: {
      maxDepth?: number
      max_depth?: number
    }
    commands?: Array<{
      id: string
      category: CheckCategory
      cwd: string
      argv: string[]
      required?: boolean
      timeoutSeconds?: number
    }>
  }
  limits?: {
    maxFiles?: number
    max_files?: number
    maxFindings?: number
    max_findings?: number
    maxCheckOutputBytes?: number
    max_check_output_bytes?: number
    maxChecks?: number
    max_checks?: number
  }
}

export interface ProcessResult {
  exitCode: number | null
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
  aborted: boolean
  truncated: boolean
}
