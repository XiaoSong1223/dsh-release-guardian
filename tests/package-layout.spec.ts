import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createRepo, removeRepo, write } from './helpers.js'
// @ts-expect-error The contract checker is an intentionally executable Node ESM script.
import { assertVersionAgreement, validateDependencySpecs, verifyPackageTree } from '../scripts/verify-package.mjs'

const execFileAsync = promisify(execFile)
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

describe('published package contract', () => {
  it('validates metadata, assets, lockfile, patch, peers, and the self-contained Codex runner', async () => {
    const packageJson = await verifyPackageTree(projectRoot)
    expect(packageJson).toMatchObject({
      name: 'dsh-release-guardian',
      main: 'lib/index.js',
      types: 'lib/types/index.d.ts',
    })
    expect(packageJson.version).toMatch(/^\d+\.\d+\.\d+/u)
  })

  it('permits only Codex build metadata on the manifest version', () => {
    const version = '1.2.3-rc.4'
    expect(() => assertVersionAgreement(version, version)).not.toThrow()
    expect(() => assertVersionAgreement(version, `${version}+codex.build-7`)).not.toThrow()
    expect(() => assertVersionAgreement(version, `${version}+build.7`)).toThrow(/Codex manifest version/u)
    expect(() => assertVersionAgreement(version, '1.2.4+codex.build-7')).toThrow(/Codex manifest version/u)
    expect(() => assertVersionAgreement('01.2.3', '01.2.3')).toThrow(/strict SemVer/u)
  })

  it('rejects local dependency specifications in every dependency class', () => {
    expect(() => validateDependencySpecs({ dependencies: { local: 'file:../local' } })).toThrow(/file:/u)
    expect(() => validateDependencySpecs({ devDependencies: { local: 'link:../local' } })).toThrow(/link:/u)
    expect(() => validateDependencySpecs({ optionalDependencies: { local: '/tmp/local' } })).toThrow(/absolute-path/u)
    expect(() => validateDependencySpecs({ peerDependencies: { local: 'C:\\local' } })).toThrow(/absolute-path/u)
  })

  it('executes the generated ESM runner for help and a real repository scan', async () => {
    const runner = resolve(projectRoot, 'skills/release-guardian/scripts/release-guardian.mjs')
    const help = await execFileAsync(process.execPath, [runner, '--help'], { cwd: projectRoot })
    expect(help.stdout).toContain('dsh-release-guardian check [options]')

    const repo = await createRepo()
    try {
      await write(repo, 'change.ts', 'export const changed = true\n')
      const scan = await execFileAsync(process.execPath, [runner, 'check', '--repo', repo, '--format', 'json'], { cwd: projectRoot })
      const report = JSON.parse(scan.stdout) as { schema_version?: string, diff?: { files_changed?: number } }
      expect(report.schema_version).toBe('1')
      expect(report.diff?.files_changed).toBe(1)
    } finally {
      await removeRepo(repo)
    }
  })

  it('creates and verifies an npm tarball without recursively invoking npm test', async () => {
    const result = await execFileAsync(process.execPath, ['scripts/pack-check.mjs'], {
      cwd: projectRoot,
      timeout: 30_000,
    })
    expect(result.stdout).toMatch(/Packed package contract passed \(\d+ files\)/u)
  }, 35_000)
})
