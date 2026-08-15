import type { CheckResult, Finding, Severity, Verdict } from './types.js'

const RISK: Record<Severity, number> = { critical: 100, high: 30, medium: 10, low: 2, info: 0 }
const CONFIDENCE_WEIGHT: Record<Finding['confidence'], number> = { high: 1, medium: 0.6, low: 0.25 }

export interface VerdictOptions {
  incomplete: boolean
  runRequested: boolean
}

export function determineVerdict(findings: readonly Finding[], checks: readonly CheckResult[], options: VerdictOptions): Verdict {
  const reasons: string[] = []
  const add = (reason: string): void => {
    if (!reasons.includes(reason)) reasons.push(reason)
  }
  const riskScore = Math.min(100, Math.round(findings.reduce((score, item) => {
    if (item.disposition === 'inform') return score
    return score + RISK[item.severity] * CONFIDENCE_WEIGHT[item.confidence]
  }, 0)))
  if (options.incomplete) add('scan-incomplete')
  for (const item of findings) {
    if (item.disposition === 'block' || item.disposition === 'review') add(item.ruleId)
  }
  for (const check of checks) {
    if (check.required && (check.status === 'failed' || check.status === 'timed_out')) add(`required-check-${check.status}:${check.id}`)
    else if (check.required && check.status === 'not_run') add('required-check-not-run')
    else if (check.required && check.status === 'unavailable') add('required-check-unavailable')
    else if (!check.required && !['passed', 'not_run'].includes(check.status)) add(`optional-check-${check.status}:${check.id}`)
  }
  if (findings.some(item => item.disposition === 'block')) return { status: 'block', riskScore, reasons }
  if (checks.some(item => item.required && (item.status === 'failed' || item.status === 'timed_out'))) return { status: 'block', riskScore, reasons }
  if (options.incomplete) return { status: 'inconclusive', riskScore, reasons }
  if (options.runRequested && checks.some(item => item.required && (item.status === 'unavailable' || item.status === 'not_run'))) {
    return { status: 'inconclusive', riskScore, reasons }
  }
  if (options.runRequested && checks.some(item => item.status === 'not_run' && item.authorization === 'approved')) {
    add('approved-check-not-run')
    return { status: 'inconclusive', riskScore, reasons }
  }
  if (findings.some(item => item.disposition === 'review')) return { status: 'review', riskScore, reasons }
  if (checks.some(item => !item.required && !['passed', 'not_run'].includes(item.status))) return { status: 'review', riskScore, reasons }
  if (checks.some(item => item.required && item.status === 'not_run')) return { status: 'review', riskScore, reasons }
  return { status: 'ready', riskScore, reasons }
}
