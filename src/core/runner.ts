import { runArgv, minimalCheckEnvironment } from './process.js'
import { resolve } from 'node:path'
import type { CheckPlan, CheckResult, GuardianConfig } from './types.js'

const OUTPUT_SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{30,255}|github_pat_[A-Za-z0-9_]{50,255})\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{20,200}\b/g,
  /\bsk_live_[A-Za-z0-9]{20,200}\b/g,
  /\bAIza[A-Za-z0-9_-]{35}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{20,}\b/gi,
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
]

const OUTPUT_SECRET_ASSIGNMENT = /((?:["'])?(?:api[_-]?key|access[_-]?key|secret[_-]?key|client[_-]?secret|auth[_-]?token|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|database[_-]?url|db[_-]?url)(?:["'])?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi
const OUTPUT_URL_CREDENTIAL = /(https?:\/\/)[^/\s:@]+:[^@\s/]+@/gi

export function redactOutput(value: string): string {
  let redacted = value
  for (const pattern of OUTPUT_SECRET_PATTERNS) {
    pattern.lastIndex = 0
    redacted = redacted.replace(pattern, '[REDACTED]')
  }
  OUTPUT_SECRET_ASSIGNMENT.lastIndex = 0
  redacted = redacted.replace(OUTPUT_SECRET_ASSIGNMENT, '$1[REDACTED]')
  OUTPUT_URL_CREDENTIAL.lastIndex = 0
  redacted = redacted.replace(OUTPUT_URL_CREDENTIAL, '$1[REDACTED]@')
  return redacted
}

function pending(plan: CheckPlan, approved: boolean): CheckResult {
  return {
    ...plan,
    authorization: approved ? 'approved' : 'required',
    status: 'not_run',
    durationMs: null,
    exitCode: null,
    stdoutTail: null,
    stderrTail: null,
    outputTruncated: false,
  }
}

export async function executeChecks(
  repoRoot: string,
  plans: readonly CheckPlan[],
  config: GuardianConfig,
  runApproved: boolean,
  approvedCommandIds: readonly string[],
  signal?: AbortSignal,
): Promise<CheckResult[]> {
  const approved = new Set(approvedCommandIds)
  const results: CheckResult[] = []
  for (const plan of plans) {
    const isApproved = approved.has(plan.id)
    if (!runApproved || !isApproved) {
      results.push(pending(plan, isApproved))
      continue
    }
    const started = Date.now()
    try {
      const processResult = await runArgv(plan.argv, {
        cwd: resolve(repoRoot, plan.cwd),
        timeoutMs: plan.timeoutMs ?? config.checkTimeoutMs,
        maxOutputBytes: config.maxCheckOutputBytes,
        ...(signal === undefined ? {} : { signal }),
        env: minimalCheckEnvironment(),
      })
      const status: CheckResult['status'] = processResult.aborted
        ? 'unavailable'
        : processResult.timedOut
        ? 'timed_out'
        : processResult.exitCode === 0
          ? 'passed'
          : 'failed'
      results.push({
        ...plan,
        authorization: 'approved',
        status,
        durationMs: processResult.durationMs,
        exitCode: processResult.exitCode,
        stdoutTail: redactOutput(processResult.stdout),
        stderrTail: redactOutput(processResult.stderr),
        outputTruncated: processResult.truncated,
      })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const unavailable = code === 'ENOENT' || code === 'EACCES'
      results.push({
        ...plan,
        authorization: 'approved',
        status: 'unavailable',
        durationMs: Date.now() - started,
        exitCode: null,
        stdoutTail: null,
        stderrTail: redactOutput(unavailable ? `command unavailable: ${plan.argv[0] ?? ''}` : String((error as Error).message)),
        outputTruncated: false,
      })
    }
  }
  return results
}
