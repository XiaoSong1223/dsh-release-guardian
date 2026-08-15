import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import * as plugin from '../src/index.js'
import { createRepo, removeRepo } from './helpers.js'

describe('DeepSeek Harness plugin contract', () => {
  it('uses namespace exports and registers a structured tool', async () => {
    expect('default' in plugin).toBe(false)
    expect(plugin.name).toBe('release-guardian')
    expect(plugin.inject).toContain('tools')
    const repo = await createRepo()
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const fiber = ctx.plugin(plugin, {
      workspaceRoot: repo,
      maxDiffBytes: 1024 * 1024,
      maxFiles: 100,
      maxFindings: 100,
      maxCheckOutputBytes: 1024,
      checkTimeoutMs: 1000,
      includeUntracked: true,
      manifestDepth: 2,
      maxChecks: 10,
    })
    await fiber
    expect(ctx.tools.schemas().map(schema => schema.name)).toContain('release_guardian_check')
    const result = await ctx.tools.execute({
      callId: 'guardian-test' as never,
      name: 'release_guardian_check',
      arguments: { repo_path: repo, action: 'discover', categories: [] },
      signal: new AbortController().signal,
    })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ schema_version: '1', verdict: { status: 'ready' } })
    const guardedRun = await ctx.tools.execute({
      callId: 'guardian-run-test' as never,
      name: 'release_guardian_check',
      arguments: { repo_path: repo, action: 'run', approved_command_ids: [] },
      signal: new AbortController().signal,
    })
    expect(guardedRun.isError).toBe(true)
    await fiber.dispose()
    expect(ctx.tools.schemas().map(schema => schema.name)).not.toContain('release_guardian_check')
    await removeRepo(repo)
  })
})
