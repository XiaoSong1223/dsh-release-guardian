import { spawnSync } from 'node:child_process'
import { accessSync, constants, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function readJson(relativePath: string): Record<string, any> {
  return JSON.parse(readFileSync(join(projectRoot, relativePath), 'utf8')) as Record<string, any>
}

function isExecutable(relativePath: string): boolean {
  try {
    accessSync(join(projectRoot, relativePath), constants.X_OK)
    return true
  } catch {
    return false
  }
}

const packageManifest = readJson('package.json')

describe('Claude Code plugin manifest', () => {
  it('identifies the same package and version as npm', () => {
    const plugin = readJson('.claude-plugin/plugin.json')
    expect(plugin.name).toBe(packageManifest.name)
    expect(plugin.version).toBe(packageManifest.version)
    expect(plugin.license).toBe(packageManifest.license)
  })

  it('declares only opt-in execution surfaces', () => {
    const plugin = readJson('.claude-plugin/plugin.json')
    expect(plugin.userConfig.commit_gate.type).toBe('boolean')
    expect(plugin.userConfig.commit_gate.default).toBe(false)
    expect(plugin.hooks).toBe('./hooks/hooks.json')
    expect(plugin.mcpServers).toBeUndefined()
  })

  it('publishes every Claude Code surface in the npm tarball', () => {
    const files: string[] = packageManifest.files
    for (const entry of ['.claude-plugin/', 'agents/', 'bin/', 'hooks/', 'skills/']) {
      expect(files).toContain(entry)
    }
    expect(files.some(entry => entry.startsWith('scripts/'))).toBe(true)
  })
})

describe('Claude Code marketplace entry', () => {
  it('points at this repository as a single plugin', () => {
    const marketplace = readJson('.claude-plugin/marketplace.json')
    expect(marketplace.name).toBe('release-guardian')
    expect(marketplace.owner.name).toBeTypeOf('string')
    expect(marketplace.plugins).toHaveLength(1)
    expect(marketplace.plugins[0].name).toBe(readJson('.claude-plugin/plugin.json').name)
    // A marketplace-root source resolves against the directory holding .claude-plugin/.
    expect(marketplace.plugins[0].source).toBe('./')
  })
})

describe('Claude Code commit gate configuration', () => {
  it('runs the bundled gate script for git commit only', () => {
    const config = readJson('hooks/hooks.json')
    const entry = config.hooks.PreToolUse[0]
    expect(entry.matcher).toBe('Bash')
    expect(entry.hooks[0].if).toBe('Bash(git commit:*)')
    expect(entry.hooks[0].command).toContain('${CLAUDE_PLUGIN_ROOT}')
    expect(entry.hooks[0].command).toContain('scripts/claude-commit-gate.mjs')
    // Invoked through node so a lost executable bit cannot disable the gate silently.
    expect(entry.hooks[0].command.startsWith('node ')).toBe(true)
  })

  it('ships the gate script as an executable', () => {
    expect(isExecutable('scripts/claude-commit-gate.mjs')).toBe(true)
  })
})

describe('release-auditor agent', () => {
  const source = readFileSync(join(projectRoot, 'agents/release-auditor.md'), 'utf8')

  it('declares a read-only tool set', () => {
    expect(source.startsWith('---\n')).toBe(true)
    const frontmatter = source.slice(4, source.indexOf('\n---', 4))
    expect(frontmatter).toContain('name: release-auditor')
    expect(frontmatter).toContain('description: ')
    expect(frontmatter).toMatch(/^tools: Bash, Read, Grep, Glob$/mu)
  })

  it('never authorizes project-code execution', () => {
    expect(source).toContain('Do not pass `--run-checks`')
  })
})

describe('bin launcher', () => {
  let workspace = ''
  let stubCli = ''

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'release-guardian-launcher-'))
    stubCli = join(workspace, 'stub-cli.js')
    await writeFile(stubCli, [
      'process.stdout.write(JSON.stringify(process.argv.slice(2)))',
      'process.exit(Number(process.env.STUB_EXIT_CODE ?? 0))',
      '',
    ].join('\n'))
  })

  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  function launch(args: string[], env: NodeJS.ProcessEnv = {}) {
    return spawnSync(join(projectRoot, 'bin/dsh-release-guardian'), args, {
      encoding: 'utf8',
      env: { ...process.env, DSH_RELEASE_GUARDIAN_CLI: stubCli, ...env },
    })
  }

  it('is executable so Claude Code can run it as a bare command', () => {
    expect(isExecutable('bin/dsh-release-guardian')).toBe(true)
  })

  it('forwards arguments verbatim without adding execution flags', () => {
    const result = launch(['check', '--repo', '/tmp/example', '--format', 'json'])
    expect(JSON.parse(result.stdout)).toEqual(['check', '--repo', '/tmp/example', '--format', 'json'])
  })

  it('propagates verdict exit codes', () => {
    expect(launch(['check'], { STUB_EXIT_CODE: '2' }).status).toBe(2)
    expect(launch(['check'], { STUB_EXIT_CODE: '3' }).status).toBe(3)
  })

  it('reports an unresolved CLI instead of guessing', async () => {
    const emptyRoot = await mkdtemp(join(tmpdir(), 'release-guardian-empty-'))
    const result = spawnSync(process.execPath, [join(projectRoot, 'bin/dsh-release-guardian'), '--help'], {
      encoding: 'utf8',
      cwd: emptyRoot,
      env: {
        ...process.env,
        DSH_RELEASE_GUARDIAN_CLI: join(emptyRoot, 'missing.js'),
        DSH_RELEASE_GUARDIAN_LAUNCHER: '1',
        PATH: emptyRoot,
      },
    })
    await rm(emptyRoot, { recursive: true, force: true })
    // A checkout that has been built resolves the bundled CLI instead of failing.
    if (result.status === 69) expect(result.stderr).toContain('no runnable CLI found')
    else expect(result.status).toBe(0)
  })
})

describe('commit gate script', () => {
  let workspace = ''
  let blockingCli = ''

  const gate = join(projectRoot, 'scripts/claude-commit-gate.mjs')

  const hookInput = (command: string) => JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    cwd: projectRoot,
    tool_input: { command },
  })

  function runGate(input: string, env: NodeJS.ProcessEnv = {}) {
    return spawnSync(process.execPath, [gate], {
      encoding: 'utf8',
      input,
      env: { ...process.env, DSH_RELEASE_GUARDIAN_CLI: blockingCli, ...env },
    })
  }

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'release-guardian-gate-'))
    blockingCli = join(workspace, 'blocking-cli.js')
    const report = {
      schema_version: '1',
      verdict: { status: 'block', risk_score: 90, reasons: ['blocking finding'] },
      summary: { findings_blocking: 1, findings_review: 0 },
      findings: [{ rule_id: 'RG001', disposition: 'block', path: 'src/app.ts', line: 12 }],
    }
    await writeFile(blockingCli, [
      `process.stdout.write(${JSON.stringify(JSON.stringify(report))})`,
      'process.exit(2)',
      '',
    ].join('\n'))
  })

  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  it('stays silent while the gate is disabled', () => {
    const result = runGate(hookInput('git commit -m "release"'), { DSH_RELEASE_GUARDIAN_COMMIT_GATE: '' })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('ignores commands that are not a git commit', () => {
    const result = runGate(hookInput('git push origin main'), { DSH_RELEASE_GUARDIAN_COMMIT_GATE: '1' })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('denies a commit on a block verdict without echoing evidence', () => {
    const result = runGate(hookInput('git add -A && git commit -m "release"'), { DSH_RELEASE_GUARDIAN_COMMIT_GATE: 'true' })
    expect(result.status).toBe(0)
    const payload = JSON.parse(result.stdout)
    expect(payload.hookSpecificOutput.hookEventName).toBe('PreToolUse')
    expect(payload.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(payload.hookSpecificOutput.permissionDecisionReason).toContain('RG001 at src/app.ts:12')
    expect(payload.hookSpecificOutput.permissionDecisionReason).toContain('--mode staged')
  })

  it('widens the scan to the worktree for git commit -a', async () => {
    const argvCli = join(workspace, 'argv-cli.js')
    const argvLog = `${argvCli}.argv`
    await writeFile(argvCli, [
      "const { writeFileSync } = require('node:fs')",
      `writeFileSync(${JSON.stringify(argvLog)}, process.argv.slice(2).join(' '))`,
      '',
    ].join('\n'))
    const result = runGate(hookInput('git commit -am "release"'), {
      DSH_RELEASE_GUARDIAN_CLI: argvCli,
      DSH_RELEASE_GUARDIAN_COMMIT_GATE: 'yes',
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('the scan produced no readable report')
    expect(readFileSync(argvLog, 'utf8')).toContain('--mode worktree')
  })
})
