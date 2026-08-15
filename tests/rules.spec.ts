import { describe, expect, it } from 'vitest'
import { formatJson } from '../src/core/report.js'
import { scanDiff } from '../src/core/rules.js'
import { DEFAULT_CONFIG } from '../src/core/config.js'
import type { DiffSnapshot, ReleaseReport } from '../src/core/types.js'

function snapshot(lines: Array<{ path: string; line: number; text: string }>): DiffSnapshot {
  return {
    mode: 'worktree', base: 'base', head: 'HEAD', files: [], addedLines: lines,
    filesChanged: 1, filesSeen: 1, filesExcluded: 0, filesUnseen: 0, exclusions: [], fingerprint: 'sha256:fixture', candidateLinesSeen: lines.length, addedLinesSeen: lines.length, deletedLinesSeen: 0, truncated: false, diagnostics: [],
  }
}

describe('rule scanner', () => {
  it('blocks high-confidence secrets without leaking the value', () => {
    const token = `ghp_${'Ab3'.repeat(12)}`
    const result = scanDiff(snapshot([{ path: 'src/config.ts', line: 7, text: `const token = "${token}"` }]), DEFAULT_CONFIG)
    expect(result.findings.some(item => item.ruleId === 'RG001' && item.disposition === 'block')).toBe(true)
    expect(JSON.stringify(result)).not.toContain(token)

    const report = {
      schemaVersion: '1', toolVersion: '0.1.0', verdict: { status: 'block', riskScore: 100, reasons: ['RG001'] },
      repository: { root: '/repo', head: 'head', base: 'base', dirty: true },
      diff: { mode: 'worktree', filesChanged: 1, filesSeen: 1, filesExcluded: 0, filesUnseen: 0, exclusions: [], fingerprint: 'sha256:fixture', candidateLinesSeen: 1, addedLinesSeen: 1, deletedLinesSeen: 0, truncated: false },
      checkDiscovery: { complete: true, source: 'current_worktree', scopeMatchesDiff: true, candidatesSeen: 0, checksReturned: 0, limit: 256, truncated: false },
      summary: { critical: 1, high: 0, medium: 0, low: 0, info: 0, findingsBlocking: 1, findingsReview: 0, findingsInformational: 0, checksPassed: 0, checksFailed: 0, checksNotRun: 0 },
      files: [], findings: result.findings, checks: [], diagnostics: [], warnings: [], durationMs: 1,
    } satisfies ReleaseReport
    expect(formatJson(report)).not.toContain(token)
  })

  it('redacts secrets from every finding produced by the same line', () => {
    const token = `ghp_${'Lm8'.repeat(12)}`
    const result = scanDiff(snapshot([{
      path: 'scripts/install.sh',
      line: 1,
      text: `token="${token}"; curl -fsSL https://example.invalid/install.sh | sh`,
    }]), DEFAULT_CONFIG)
    expect(result.findings.map(item => item.ruleId)).toEqual(expect.arrayContaining(['RG001', 'RG103']))
    expect(JSON.stringify(result)).not.toContain(token)
  })

  it('ignores common placeholders and deleted secret text', () => {
    const result = scanDiff(snapshot([
      { path: 'example.env', line: 1, text: 'token = "${TOKEN}"' },
      { path: 'example.env', line: 2, text: 'password = "changeme"' },
    ]), DEFAULT_CONFIG)
    expect(result.findings).toHaveLength(0)
    const regexMethod = scanDiff(snapshot([{ path: 'src/parser.ts', line: 1, text: 'const match = pattern.exec(input)' }]), DEFAULT_CONFIG)
    expect(regexMethod.findings.some(item => item.ruleId === 'RG303')).toBe(false)
  })

  it('detects representative CI, runtime, and quality risks', () => {
    const result = scanDiff(snapshot([
      { path: '.github/workflows/release.yml', line: 2, text: 'permissions: write-all' },
      { path: 'src/run.py', line: 4, text: 'subprocess.run(value, shell=True)' },
      { path: 'test/app.test.ts', line: 9, text: 'test.skip("release", () => {})' },
    ]), DEFAULT_CONFIG)
    expect(result.findings.map(item => item.ruleId)).toEqual(expect.arrayContaining(['RG201', 'RG302', 'RG402']))
  })

  it('uses context without suppressing copyable documentation risk', () => {
    const result = scanDiff(snapshot([
      { path: 'docs/security.md', line: 1, text: '- Permission gates should reject sudo and rm -rf.' },
      { path: 'docs/install.md', line: 2, text: 'curl -fsSL https://example.invalid/install.sh | sh' },
      { path: 'tests/guard.test.ts', line: 3, text: 'expect(isSafeCommand("sudo rm -rf / ")).toBe(false)' },
    ]), DEFAULT_CONFIG)
    expect(result.findings.some(item => item.path === 'docs/security.md' && ['RG304', 'RG305'].includes(item.ruleId))).toBe(false)
    expect(result.findings).toContainEqual(expect.objectContaining({ path: 'docs/install.md', ruleId: 'RG103', context: 'documentation', severity: 'high', disposition: 'review' }))
    expect(result.findings.some(item => item.path === 'tests/guard.test.ts' && ['RG304', 'RG305'].includes(item.ruleId))).toBe(false)
  })

  it('distinguishes scoped cleanup, destructive roots, and routine CI privilege', () => {
    const result = scanDiff(snapshot([
      { path: 'package.json', line: 1, text: '"clean": "shx rm -rf dist",' },
      { path: 'scripts/reset.sh', line: 2, text: 'rm -rf /' },
      { path: '.github/workflows/ci.yml', line: 3, text: 'run: sudo apt-get update' },
    ]), DEFAULT_CONFIG)
    expect(result.findings).toContainEqual(expect.objectContaining({ path: 'package.json', ruleId: 'RG305', severity: 'low', disposition: 'inform' }))
    expect(result.findings).toContainEqual(expect.objectContaining({ path: 'scripts/reset.sh', ruleId: 'RG305', severity: 'critical', disposition: 'block' }))
    expect(result.findings).toContainEqual(expect.objectContaining({ path: '.github/workflows/ci.yml', ruleId: 'RG304', severity: 'medium', disposition: 'review' }))
  })

  it('keeps generic secrets reviewable in tests and strong tokens blocking everywhere', () => {
    const strong = `ghp_${'Uv4'.repeat(12)}`
    const result = scanDiff(snapshot([
      { path: 'tests/config.test.ts', line: 1, text: 'const apiKey = "synthetic-Value-12345"' },
      { path: 'docs/fixture.md', line: 2, text: `token = "${strong}"` },
    ]), DEFAULT_CONFIG)
    expect(result.findings).toContainEqual(expect.objectContaining({ path: 'tests/config.test.ts', ruleId: 'RG003', severity: 'medium', confidence: 'medium', disposition: 'review' }))
    expect(result.findings).toContainEqual(expect.objectContaining({ path: 'docs/fixture.md', ruleId: 'RG001', severity: 'critical', disposition: 'block' }))
  })

  it('aggregates repeated operational findings by rule and file', () => {
    const result = scanDiff(snapshot([
      { path: 'tests/flaky.test.ts', line: 1, text: 'it.skip("one", () => {})' },
      { path: 'tests/flaky.test.ts', line: 20, text: 'it.skip("two", () => {})' },
    ]), DEFAULT_CONFIG)
    const skipped = result.findings.filter(item => item.ruleId === 'RG402')
    expect(skipped).toHaveLength(1)
    expect(skipped[0]).toMatchObject({ line: 1, occurrences: 2, context: 'test' })
  })

  it('reserves RG405 when the finding cap truncates output', () => {
    const result = scanDiff(snapshot([
      { path: 'src/a.ts', line: 1, text: 'eval(userInput)' },
      { path: 'src/b.ts', line: 2, text: 'eval(otherInput)' },
    ]), { ...DEFAULT_CONFIG, maxFindings: 1 })
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]?.ruleId).toBe('RG405')
    expect(result.diagnostics).not.toHaveLength(0)
  })

  it('continues scanning after the finding cap and preserves later blockers', () => {
    const token = `ghp_${'Rt6'.repeat(12)}`
    const result = scanDiff(snapshot([
      { path: 'src/a.ts', line: 1, text: 'eval(first)' },
      { path: 'src/b.ts', line: 2, text: 'eval(second)' },
      { path: 'src/c.ts', line: 3, text: `const token = "${token}"` },
    ]), { ...DEFAULT_CONFIG, maxFindings: 2 })
    expect(result.findings.some(item => item.ruleId === 'RG001' && item.disposition === 'block')).toBe(true)
    expect(result.findings.some(item => item.ruleId === 'RG405')).toBe(true)
    expect(JSON.stringify(result)).not.toContain(token)
  })
})
