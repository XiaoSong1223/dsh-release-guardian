#!/usr/bin/env node
// Claude Code PreToolUse gate: scan what a `git commit` is about to record, and deny the
// commit when Release Guardian returns a `block` verdict.
//
// The gate is opt-in (plugin option `commit_gate`), read-only, and never runs project code.
// It is an advisory control, not a security boundary: any internal failure allows the commit
// and reports that the gate did not run.
import { spawnSync } from 'node:child_process'
import { isAbsolute, resolve } from 'node:path'
import { launcherEnv, resolveGuardianCli } from './guardian-cli-path.mjs'

const MAX_INPUT_BYTES = 1024 * 1024
const MAX_REPORT_BYTES = 32 * 1024 * 1024
const SCAN_TIMEOUT_MS = 90_000
const MAX_REPORTED_FINDINGS = 5
const ENABLED_VALUES = new Set(['1', 'true', 'yes', 'on'])
const GATE_ENV_KEYS = ['DSH_RELEASE_GUARDIAN_COMMIT_GATE', 'CLAUDE_PLUGIN_OPTION_COMMIT_GATE', 'CLAUDE_PLUGIN_OPTION_commit_gate']
// Git global options that consume the following argument.
const GIT_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env'])

function allow() {
  process.exit(0)
}

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
  process.exit(0)
}

function warn(message) {
  emit({ systemMessage: `Release Guardian commit gate: ${message}` })
}

function gateEnabled(env) {
  return GATE_ENV_KEYS.some(key => ENABLED_VALUES.has((env[key] ?? '').trim().toLowerCase()))
}

async function readInput() {
  const chunks = []
  let size = 0
  for await (const chunk of process.stdin) {
    size += chunk.length
    if (size > MAX_INPUT_BYTES) return null
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  }
}

/**
 * Find a `git commit` invocation in a shell command line.
 * Segmentation is deliberately conservative: a quoted separator can split a segment early,
 * which can only produce an extra candidate, never hide one.
 *
 * @returns {{ repoOption: string | null, all: boolean } | null}
 */
function findCommit(command) {
  for (const segment of command.split(/\|\||&&|[;\n|&]/u)) {
    const tokens = segment.trim().split(/\s+/u).filter(token => token !== '')
    const start = tokens.findIndex(token => token === 'git' || token.endsWith('/git'))
    if (start === -1) continue
    let index = start + 1
    let repoOption = null
    while (index < tokens.length && tokens[index].startsWith('-')) {
      const flag = tokens[index]
      if (GIT_VALUE_FLAGS.has(flag)) {
        if (flag === '-C') repoOption = tokens[index + 1] ?? null
        index += 2
        continue
      }
      index += 1
    }
    if (tokens[index] !== 'commit') continue
    const rest = tokens.slice(index + 1)
    const all = rest.some(token => token === '--all' || /^-[a-zA-Z]*a/u.test(token))
    return { repoOption, all }
  }
  return null
}

function scan(argv, repoPath, all) {
  // `git commit -a` also records unstaged tracked changes, so widen the scan to the worktree.
  const modeArgs = all
    ? ['--mode', 'worktree', '--include-untracked', 'false']
    : ['--mode', 'staged']
  const [command, ...leading] = argv
  return spawnSync(command, [...leading, 'check', '--repo', repoPath, ...modeArgs, '--format', 'json'], {
    encoding: 'utf8',
    timeout: SCAN_TIMEOUT_MS,
    maxBuffer: MAX_REPORT_BYTES,
    env: launcherEnv(),
  })
}

// Only rule IDs and locations are reported. Finding text is never echoed, so redacted
// evidence cannot travel further than the report the user asked for.
function describeFindings(report, disposition) {
  const matched = report.findings.filter(finding => finding.disposition === disposition)
  const shown = matched.slice(0, MAX_REPORTED_FINDINGS)
    .map(finding => `${finding.rule_id} at ${finding.path}${finding.line === null ? '' : `:${finding.line}`}`)
  const remaining = matched.length - shown.length
  if (shown.length === 0) return report.verdict.reasons.slice(0, MAX_REPORTED_FINDINGS).join('; ')
  return `${shown.join('; ')}${remaining > 0 ? `; and ${remaining} more` : ''}`
}

const input = await readInput()
if (input === null || input.hook_event_name !== 'PreToolUse' || input.tool_name !== 'Bash') allow()
if (!gateEnabled(process.env)) allow()

const command = input.tool_input?.command
if (typeof command !== 'string' || command === '') allow()
const commit = findCommit(command)
if (commit === null) allow()

const cwd = typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : process.cwd()
const repoPath = commit.repoOption === null
  ? cwd
  : (isAbsolute(commit.repoOption) ? commit.repoOption : resolve(cwd, commit.repoOption))

const resolved = resolveGuardianCli({ moduleUrl: import.meta.url })
if (resolved === null) warn('no built CLI was found, so this commit was not scanned.')

const result = scan(resolved.argv, repoPath, commit.all)
if (result.error !== undefined) warn(`the scan could not start (${result.error.message}), so this commit was not scanned.`)
if (result.signal !== null && result.signal !== undefined) warn(`the scan was terminated (${result.signal}), so this commit was not scanned.`)

let report
try {
  report = JSON.parse(result.stdout)
} catch {
  warn('the scan produced no readable report, so this commit was not scanned.')
}
if (report.schema_version !== '1') warn(`report schema ${String(report.schema_version)} is not supported, so this commit was not scanned.`)

const scope = commit.all ? 'worktree' : 'staged'
if (report.verdict.status === 'block') {
  emit({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: [
        `Release Guardian returned a block verdict for the ${scope} changes in ${repoPath}: ${describeFindings(report, 'block')}.`,
        `Run \`dsh-release-guardian check --repo ${repoPath} --mode ${scope}\` for the full report and \`dsh-release-guardian explain RULE_ID\` for remediation.`,
        'Resolve the blocking findings, or ask the user to disable the plugin\'s commit_gate option before committing.',
      ].join(' '),
    },
  })
}
if (report.verdict.status === 'inconclusive') {
  warn(`the ${scope} scan of ${repoPath} was inconclusive, so the commit was not gated.`)
}
if (report.verdict.status === 'review') {
  emit({
    systemMessage: `Release Guardian: ${report.summary.findings_review} finding(s) need review in the ${scope} changes (commit allowed).`,
    additionalContext: `Release Guardian scanned the ${scope} changes in ${repoPath} and returned a review verdict: ${describeFindings(report, 'review')}. Report this to the user, and run \`dsh-release-guardian check --repo ${repoPath} --mode ${scope}\` if they want detail.`,
  })
}
allow()
