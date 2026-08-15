#!/usr/bin/env node
import { writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { auditRelease } from './core/audit.js'
import { formatJson, formatText } from './core/report.js'
import { getRule, RULES } from './core/rules.js'
import type { AuditRequest, CheckCategory, DiffMode, GuardianConfig, ReleaseReport } from './core/types.js'

const HELP = `dsh-release-guardian — local, read-only release risk checks

Usage:
  dsh-release-guardian check [options]
  dsh-release-guardian rules
  dsh-release-guardian explain RULE_ID

Options:
  --repo PATH                    Repository path (default: current directory)
  --mode worktree|staged|range  Diff mode
  --base REF                    Base ref; implies range mode
  --head REF                    Head ref (default: HEAD)
  --include-untracked BOOL      Include untracked files (default: true)
  --config PATH                 Project config (default: .release-guardian.yml)
  --format text|json            Report format (default: text)
  --output PATH                 Write a new report file; never overwrites
  --checks LIST                 test,typecheck,build
  --check-id ID                 Execute only this discovered check ID; repeatable
  --run-checks                  Run only the displayed check plan after approval
  --yes                         Non-interactive approval; requires --run-checks
  --fail-on review|block        Exit threshold (default: block)
  --max-diff-bytes N            Diff scan byte limit
  --timeout SECONDS             Per-check timeout
  --help                        Show this help
`

class UsageError extends Error {}

interface CliOptions {
  request: AuditRequest
  format: 'text' | 'json'
  output?: string
  runChecks: boolean
  yes: boolean
  failOn: 'review' | 'block'
  baseConfig: Partial<GuardianConfig>
  selectedCheckIds: string[]
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) throw new UsageError(`${flag} requires a value`)
  return value
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new UsageError(`${flag} must be a positive integer`)
  return parsed
}

function parseBoolean(value: string, flag: string): boolean {
  if (value === 'true') return true
  if (value === 'false') return false
  throw new UsageError(`${flag} must be true or false`)
}

function parseCheckOptions(args: string[]): CliOptions {
  let repoPath = process.cwd()
  let mode: DiffMode | undefined
  let base: string | undefined
  let head: string | undefined
  let includeUntracked: boolean | undefined
  let configPath: string | undefined
  let categories: CheckCategory[] | undefined
  let maxDiffBytes: number | undefined
  let output: string | undefined
  let format: CliOptions['format'] = 'text'
  let runChecks = false
  let yes = false
  let failOn: CliOptions['failOn'] = 'block'
  const selectedCheckIds: string[] = []
  const baseConfig: Partial<GuardianConfig> = {}
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!
    if (flag === '--help') {
      process.stdout.write(HELP)
      process.exitCode = 0
      throw new UsageError('')
    }
    if (flag === '--run-checks') { runChecks = true; continue }
    if (flag === '--yes') { yes = true; continue }
    const value = requireValue(args, index, flag)
    index += 1
    switch (flag) {
      case '--repo': repoPath = value; break
      case '--mode':
        if (!['worktree', 'staged', 'range'].includes(value)) throw new UsageError('--mode is invalid')
        mode = value as DiffMode
        break
      case '--base': base = value; break
      case '--head': head = value; break
      case '--include-untracked': includeUntracked = parseBoolean(value, flag); break
      case '--config': configPath = value; break
      case '--format':
        if (value !== 'text' && value !== 'json') throw new UsageError('--format must be text or json')
        format = value
        break
      case '--output': output = value; break
      case '--checks': {
        const parsed = value.split(',')
        if (parsed.length === 0 || parsed.some(item => !['test', 'typecheck', 'build'].includes(item))) throw new UsageError('--checks contains an unsupported category')
        categories = parsed as CheckCategory[]
        break
      }
      case '--check-id':
        if (!/^sha256:[a-f0-9]{64}$/u.test(value)) throw new UsageError('--check-id must be a discovered sha256 command ID')
        if (!selectedCheckIds.includes(value)) selectedCheckIds.push(value)
        break
      case '--fail-on':
        if (value !== 'review' && value !== 'block') throw new UsageError('--fail-on must be review or block')
        failOn = value
        break
      case '--max-diff-bytes': maxDiffBytes = positiveInteger(value, flag); break
      case '--timeout': baseConfig.checkTimeoutMs = positiveInteger(value, flag) * 1_000; break
      default: throw new UsageError(`unknown option: ${flag}`)
    }
  }
  if (yes && !runChecks) throw new UsageError('--yes requires --run-checks')
  if (selectedCheckIds.length > 0 && !runChecks) throw new UsageError('--check-id requires --run-checks')
  if (base !== undefined && mode !== undefined && mode !== 'range') throw new UsageError('--base conflicts with a non-range --mode')
  if (mode === 'range' && base === undefined) throw new UsageError('range mode requires --base')
  const request: AuditRequest = {
    repoPath,
    ...(mode === undefined ? {} : { mode }),
    ...(base === undefined ? {} : { base }),
    ...(head === undefined ? {} : { head }),
    ...(includeUntracked === undefined ? {} : { includeUntracked }),
    ...(configPath === undefined ? {} : { configPath }),
    ...(categories === undefined ? {} : { categories }),
    ...(maxDiffBytes === undefined ? {} : { maxDiffBytes }),
  }
  return { request, format, ...(output === undefined ? {} : { output }), runChecks, yes, failOn, baseConfig, selectedCheckIds }
}

async function confirmChecks(checks: ReleaseReport['checks'], yes: boolean): Promise<boolean> {
  if (checks.length === 0) return true
  process.stderr.write('Release Guardian will execute repository code without a sandbox:\n')
  for (const check of checks) {
    process.stderr.write(`  ${check.id}  ${check.cwd || '.'}  ${check.argv.map(value => JSON.stringify(value)).join(' ')}\n`)
  }
  if (yes) return true
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw new UsageError('--run-checks in a non-interactive session requires --yes')
  const terminal = createInterface({ input: process.stdin, output: process.stderr })
  try {
    const answer = await terminal.question('Run exactly these commands? [y/N] ')
    return /^(?:y|yes)$/i.test(answer.trim())
  } finally {
    terminal.close()
  }
}

function exitCode(report: ReleaseReport, failOn: CliOptions['failOn']): number {
  if (report.verdict.status === 'inconclusive') return 3
  if (report.verdict.status === 'block') return 2
  if (report.verdict.status === 'review' && failOn === 'review') return 1
  return 0
}

async function checkCommand(args: string[]): Promise<number> {
  const options = parseCheckOptions(args)
  let report = await auditRelease(options.request, options.baseConfig)
  if (options.runChecks) {
    const checksById = new Map(report.checks.map(check => [check.id, check]))
    const approvedChecks = options.selectedCheckIds.length === 0
      ? report.checks
      : options.selectedCheckIds.map(id => {
        const check = checksById.get(id)
        if (check === undefined) throw new UsageError(`--check-id was not found in the current plan: ${id}`)
        return check
      })
    if (await confirmChecks(approvedChecks, options.yes)) {
      report = await auditRelease({
        ...options.request,
        runApprovedChecks: true,
        approvedCommandIds: approvedChecks.map(check => check.id),
      }, options.baseConfig)
    } else {
      process.stderr.write('Checks were not run.\n')
    }
  }
  const rendered = options.format === 'json' ? formatJson(report) : formatText(report)
  if (options.output === undefined) process.stdout.write(rendered)
  else await writeFile(options.output, rendered, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  return exitCode(report, options.failOn)
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const [command = 'check', ...args] = argv
  if (command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(HELP)
    return 0
  }
  if (command === 'rules') {
    for (const rule of RULES) process.stdout.write(`${rule.id}\t${rule.severity}\t${rule.disposition}\t${rule.title}\n`)
    return 0
  }
  if (command === 'explain') {
    if (args.length !== 1) throw new UsageError('explain requires one rule ID')
    const rule = getRule(args[0]!)
    if (rule === undefined) throw new UsageError(`unknown rule: ${args[0] ?? ''}`)
    process.stdout.write(`${rule.id} — ${rule.title}\nSeverity: ${rule.severity}\nDisposition: ${rule.disposition}\nRemediation: ${rule.remediation}\n`)
    return 0
  }
  if (command !== 'check') throw new UsageError(`unknown command: ${command}`)
  return await checkCommand(args)
}

main().then(code => {
  process.exitCode = code
}).catch(error => {
  if (error instanceof UsageError) {
    if (error.message !== '') process.stderr.write(`error: ${error.message}\n`)
    if (process.exitCode === undefined) process.exitCode = error.message === '' ? 0 : 64
  } else {
    process.stderr.write(`fatal: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 3
  }
})
