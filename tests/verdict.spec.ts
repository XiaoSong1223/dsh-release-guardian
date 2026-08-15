import { describe, expect, it } from 'vitest'
import { determineVerdict } from '../src/core/verdict.js'
import type { CheckResult, Finding } from '../src/core/types.js'

const baseFinding: Finding = {
  ruleId: 'RG201', severity: 'high', disposition: 'review', confidence: 'high', context: 'ci', rationale: ['fixture'], occurrences: 1, path: 'ci.yml', line: 1,
  message: 'review', evidenceRedacted: 'permissions: write-all', fingerprint: 'sha256:f', remediation: 'scope it',
}

function check(overrides: Partial<CheckResult>): CheckResult {
  return {
    id: 'sha256:c', category: 'test', cwd: '.', argv: ['node', '--test'], detectedBy: 'fixture', required: true,
    manifestFingerprint: 'sha256:m', authorization: 'required', status: 'not_run', durationMs: null,
    exitCode: null, stdoutTail: null, stderrTail: null, outputTruncated: false, ...overrides,
  }
}

describe('verdict precedence', () => {
  it('preserves confirmed blockers even when the scan is incomplete', () => {
    const block = { ...baseFinding, ruleId: 'RG001', severity: 'critical', disposition: 'block' } satisfies Finding
    const verdict = determineVerdict([block], [], { incomplete: true, runRequested: false })
    expect(verdict.status).toBe('block')
    expect(verdict.reasons).toContain('scan-incomplete')
  })

  it('blocks required failures and reviews unrun required checks', () => {
    expect(determineVerdict([], [check({ status: 'failed' })], { incomplete: false, runRequested: true }).status).toBe('block')
    expect(determineVerdict([], [check({})], { incomplete: false, runRequested: false }).status).toBe('review')
  })

  it('returns ready only when no gate needs attention', () => {
    expect(determineVerdict([], [check({ status: 'passed', authorization: 'approved' })], { incomplete: false, runRequested: true }).status).toBe('ready')
  })

  it('allows an explicitly unselected optional check to remain not run', () => {
    const selected = check({ required: false, status: 'passed', authorization: 'approved' })
    const unselected = check({ id: 'sha256:optional', required: false, status: 'not_run', authorization: 'required' })
    expect(determineVerdict([], [selected, unselected], { incomplete: false, runRequested: true }).status).toBe('ready')
  })
})
