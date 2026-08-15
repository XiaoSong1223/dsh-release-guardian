import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG } from '../src/core/config.js'
import { discoverChecks, discoverChecksDetailed } from '../src/core/discovery.js'
import { command, write } from './helpers.js'

describe('cross-language check discovery', () => {
  let root: string
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'guardian-discovery-')) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('discovers six ecosystems without executing project code', async () => {
    await write(root, 'js/package.json', JSON.stringify({ scripts: { test: 'node malicious.js', typecheck: 'tsc', build: 'vite build' } }))
    await write(root, 'js/package-lock.json', '{}')
    await write(root, 'python/pyproject.toml', '[build-system]\nrequires=[]\n[tool.pytest.ini_options]\n[tool.mypy]\n')
    await write(root, 'go/go.mod', 'module example.invalid/test\n')
    await write(root, 'rust/Cargo.toml', '[package]\nname="fixture"\nversion="0.0.0"\n')
    await write(root, 'java/pom.xml', '<project/>\n')
    await write(root, 'dotnet/App.csproj', '<Project/>\n')
    await write(root, 'nested/node_modules/evil/package.json', JSON.stringify({ scripts: { test: 'touch should-not-run' } }))
    const diagnostics: string[] = []
    const plans = await discoverChecks(root, { ...DEFAULT_CONFIG, requiredChecks: ['test'] }, ['test', 'typecheck', 'build'], diagnostics)
    expect(diagnostics).toEqual([])
    expect(plans.some(plan => plan.detectedBy.startsWith('js/package.json') && plan.argv.join(' ') === 'npm --offline run test')).toBe(true)
    expect(plans.some(plan => plan.argv.join(' ') === 'python -m pytest')).toBe(true)
    expect(plans.some(plan => plan.argv[0] === 'go')).toBe(true)
    expect(plans.some(plan => plan.argv[0] === 'cargo' && plan.argv.includes('--offline'))).toBe(true)
    expect(plans.some(plan => plan.argv[0] === 'mvn' && plan.argv.includes('--offline'))).toBe(true)
    expect(plans.some(plan => plan.argv[0] === 'dotnet' && plan.argv.includes('--no-restore'))).toBe(true)
    expect(plans.every(plan => !plan.cwd.startsWith(root))).toBe(true)
    expect(plans.filter(plan => plan.category === 'test').every(plan => plan.required)).toBe(true)
    expect(plans.some(plan => plan.detectedBy.includes('node_modules'))).toBe(false)
  })

  it('prioritizes configured argv and truncates fail-closed', async () => {
    await write(root, 'package.json', JSON.stringify({ scripts: { test: 'exit 1', build: 'exit 1' } }))
    const diagnostics: string[] = []
    const plans = await discoverChecks(root, {
      ...DEFAULT_CONFIG,
      maxChecks: 1,
      commands: [{ id: 'safe-test', category: 'test', cwd: '.', argv: ['node', '--test'], required: true }],
    }, ['test', 'build'], diagnostics)
    expect(plans).toHaveLength(1)
    expect(plans[0]?.detectedBy).toBe('configured:safe-test')
    expect(diagnostics.join('\n')).toContain('truncated')
  })

  it('uses an executable project-local Python environment without scanning it', async () => {
    await write(root, 'python/pyproject.toml', '[tool.pytest.ini_options]\n')
    const localPythonRelative = process.platform === 'win32'
      ? 'python/.venv/Scripts/python.exe'
      : 'python/.venv/bin/python'
    const expectedExecutable = process.platform === 'win32'
      ? './.venv/Scripts/python.exe'
      : './.venv/bin/python'
    const localPython = join(root, localPythonRelative)
    await write(root, localPythonRelative, '#!/bin/sh\nexit 0\n')
    await chmod(localPython, 0o755)

    const result = await discoverChecksDetailed(root, DEFAULT_CONFIG, ['test'])

    expect(result.complete).toBe(true)
    expect(result.plans).toHaveLength(1)
    expect(result.plans[0]?.argv).toEqual([expectedExecutable, '-m', 'pytest'])
    expect(result.plans[0]?.detectedBy).toBe('python/pyproject.toml#tool.pytest')
  })

  it('ignores nested agent worktrees and treats outside symlinks as warnings', async () => {
    await write(root, '.claude/worktrees/nested/package.json', JSON.stringify({ scripts: { test: 'exit 1' } }))
    const outside = await mkdtemp(join(tmpdir(), 'guardian-outside-'))
    try {
      await write(outside, 'package.json', JSON.stringify({ scripts: { test: 'exit 1' } }))
      const { symlink } = await import('node:fs/promises')
      await symlink(join(outside, 'package.json'), join(root, 'python'))
      const diagnostics: string[] = []
      const warnings: string[] = []
      const plans = await discoverChecks(root, DEFAULT_CONFIG, ['test'], diagnostics, warnings)
      expect(plans).toEqual([])
      expect(diagnostics).toEqual([])
      expect(warnings.join('\n')).toContain('outside repository')
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('marks an external manifest symlink as incomplete', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'guardian-outside-manifest-'))
    try {
      await write(outside, 'package.json', JSON.stringify({ scripts: { test: 'exit 1' } }))
      const { symlink } = await import('node:fs/promises')
      await symlink(join(outside, 'package.json'), join(root, 'package.json'))
      const result = await discoverChecksDetailed(root, DEFAULT_CONFIG, ['test'])
      expect(result.plans).toEqual([])
      expect(result.complete).toBe(false)
      expect(result.diagnostics.join('\n')).toContain('outside repository')
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('uses Git-visible manifests and ignores local ignored worktrees', async () => {
    await command(root, 'git', ['init'])
    await write(root, '.gitignore', '.claude/worktrees/\n.venv/\nignored/\n')
    await write(root, 'package.json', JSON.stringify({ scripts: { test: 'node --test' } }))
    await write(root, '.claude/worktrees/local/package.json', JSON.stringify({ scripts: { test: 'exit 1' } }))
    await write(root, '.venv/package.json', JSON.stringify({ scripts: { test: 'exit 1' } }))
    await write(root, 'ignored/package.json', JSON.stringify({ scripts: { build: 'node build.js' } }))
    await command(root, 'git', ['add', '.gitignore', 'package.json'])
    await command(root, 'git', ['add', '-f', 'ignored/package.json'])
    const result = await discoverChecksDetailed(root, DEFAULT_CONFIG, ['test', 'build'])
    expect(result.complete).toBe(true)
    expect(result.plans.some(plan => plan.detectedBy.startsWith('package.json'))).toBe(true)
    expect(result.plans.some(plan => plan.detectedBy.startsWith('ignored/package.json'))).toBe(true)
    expect(result.plans.every(plan => !plan.detectedBy.includes('.claude/worktrees') && !plan.detectedBy.includes('.venv'))).toBe(true)
  })
})
