import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG } from '../src/core/config.js'
import { executeChecks } from '../src/core/runner.js'
import type { CheckPlan } from '../src/core/types.js'

describe('authorized argv runner', () => {
  let root: string
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'guardian-runner-')) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  function plan(argv: string[]): CheckPlan {
    return { id: 'sha256:approved', category: 'test', cwd: '.', argv, detectedBy: 'fixture', required: true, manifestFingerprint: 'sha256:manifest' }
  }

  it('runs nothing by default or without the exact command ID', async () => {
    const marker = join(root, 'marker')
    const candidate = plan([process.execPath, '-e', 'require("node:fs").writeFileSync("marker", "ran")'])
    const defaults = await executeChecks(root, [candidate], DEFAULT_CONFIG, false, [], undefined)
    expect(defaults[0]?.status).toBe('not_run')
    const denied = await executeChecks(root, [candidate], DEFAULT_CONFIG, true, ['sha256:different'], undefined)
    expect(denied[0]?.status).toBe('not_run')
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('executes an exact approved argv and redacts output', async () => {
    const token = `ghp_${'Q7x'.repeat(12)}`
    const candidate = plan([process.execPath, '-e', `process.stdout.write("${token}")`])
    const results = await executeChecks(root, [candidate], { ...DEFAULT_CONFIG, maxCheckOutputBytes: 1024 }, true, [candidate.id], undefined)
    expect(results[0]?.status).toBe('passed')
    expect(results[0]?.stdoutTail).toBe('[REDACTED]')
  })

  it('redacts labeled credentials and URL userinfo from check output', async () => {
    const candidate = plan([
      process.execPath,
      '-e',
      'process.stdout.write(`API_KEY=plain-sensitive\\n{"password":"hunter2"}\\nhttps://alice:supersecret@example.invalid/path`)',
    ])
    const results = await executeChecks(root, [candidate], { ...DEFAULT_CONFIG, maxCheckOutputBytes: 1024 }, true, [candidate.id], undefined)
    const output = results[0]?.stdoutTail ?? ''
    expect(results[0]?.status).toBe('passed')
    expect(output).not.toContain('plain-sensitive')
    expect(output).not.toContain('hunter2')
    expect(output).not.toContain('alice:supersecret')
    expect(output.match(/\[REDACTED\]/g)).toHaveLength(3)
  })

  it('bounds captured output independently of process timing', async () => {
    const noisy = plan([process.execPath, '-e', 'process.stdout.write("x".repeat(4096))'])
    const results = await executeChecks(root, [noisy], { ...DEFAULT_CONFIG, checkTimeoutMs: 2_000, maxCheckOutputBytes: 64 }, true, [noisy.id], undefined)
    expect(results[0]?.status).toBe('passed')
    expect(results[0]?.outputTruncated).toBe(true)
    expect(Buffer.byteLength(results[0]?.stdoutTail ?? '')).toBeLessThanOrEqual(64)
  })

  it('enforces the configured timeout', async () => {
    const slow = plan([process.execPath, '-e', 'setTimeout(() => {}, 2000)'])
    const results = await executeChecks(root, [slow], { ...DEFAULT_CONFIG, checkTimeoutMs: 200 }, true, [slow.id], undefined)
    expect(results[0]?.status).toBe('timed_out')
  })
})
