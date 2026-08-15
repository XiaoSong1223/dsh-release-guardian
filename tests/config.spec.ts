import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/core/config.js'

describe('project configuration', () => {
  it('accepts snake_case fields and argv-only configured checks', () => {
    const config = resolveConfig({}, {
      version: 1,
      diff: { include_untracked: false, max_bytes: 1234 } as never,
      checks: {
        required: ['test'],
        discover: { max_depth: 2 } as never,
        commands: [{ id: 'api-test', category: 'test', cwd: 'api', argv: ['python', '-m', 'pytest'], required: true, timeoutSeconds: 10 }],
      },
      limits: { max_files: 12, max_findings: 13, max_check_output_bytes: 14, max_checks: 15 } as never,
    })
    expect(config).toMatchObject({ includeUntracked: false, maxDiffBytes: 1234, manifestDepth: 2, maxFiles: 12, maxChecks: 15 })
    expect(config.commands[0]?.argv).toEqual(['python', '-m', 'pytest'])
    expect(config.commands[0]?.timeoutMs).toBe(10_000)
  })

  it('rejects unknown fields, duplicate IDs, shell strings, and non-boolean flags', () => {
    expect(() => resolveConfig({}, { version: 1, surprise: true } as never)).toThrow(/unknown fields/)
    expect(() => resolveConfig({}, {
      version: 1,
      checks: { commands: [
        { id: 'same', category: 'test', cwd: '.', argv: ['node', '--test'] },
        { id: 'same', category: 'build', cwd: '.', argv: ['node', 'build.js'] },
      ] },
    })).toThrow(/duplicate/)
    expect(() => resolveConfig({}, { version: 1, checks: { commands: [{ id: 'bad', category: 'test', cwd: '.', argv: 'npm test' as never }] } })).toThrow(/string array/)
    expect(() => resolveConfig({}, { version: 1, diff: { includeUntracked: 'false' as never } })).toThrow(/boolean/)
  })
})
