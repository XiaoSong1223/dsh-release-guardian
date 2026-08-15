import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import { auditRelease } from './core/audit.js'
import { toJsonReport } from './core/report.js'
import type { CheckCategory, DiffMode, GuardianConfig } from './core/types.js'

export const name = 'release-guardian'
export const inject = ['tools'] as const

export interface Config {
  workspaceRoot: string
  maxDiffBytes: number
  maxFiles: number
  maxFindings: number
  maxCheckOutputBytes: number
  checkTimeoutMs: number
  includeUntracked: boolean
  manifestDepth: number
  maxChecks: number
}

export const Config: Schema<Config> = Schema.object({
  workspaceRoot: Schema.string().default('.').description('Default repository path for tool calls.'),
  maxDiffBytes: Schema.natural().min(1).default(10 * 1024 * 1024),
  maxFiles: Schema.natural().min(1).default(5_000),
  maxFindings: Schema.natural().min(1).default(500),
  maxCheckOutputBytes: Schema.natural().min(1).default(64 * 1024),
  checkTimeoutMs: Schema.natural().min(1).default(10 * 60 * 1_000),
  includeUntracked: Schema.boolean().default(true),
  manifestDepth: Schema.natural().min(1).default(4),
  maxChecks: Schema.natural().min(1).default(256),
})

const parameters = {
  schema_version: { type: 'string', const: '1', description: 'Request schema version.' },
  repo_path: { type: 'string', description: 'Absolute path to the Git repository. Defaults to the plugin workspaceRoot.' },
  config_path: { type: 'string', description: 'Optional repository-relative .release-guardian.yml path.' },
  mode: { type: 'string', enum: ['worktree', 'staged', 'range'], description: 'Git diff mode.' },
  base: { type: 'string', description: 'Base Git ref. Supplying it implies range mode.' },
  head: { type: 'string', description: 'Head Git ref; defaults to HEAD.' },
  include_untracked: { type: 'boolean', description: 'Include untracked files in worktree mode.' },
  max_diff_bytes: { type: 'integer', description: 'Maximum diff bytes to scan.' },
  categories: {
    type: 'array',
    items: { type: 'string', enum: ['test', 'typecheck', 'build'] },
    description: 'Check categories to discover.',
  },
  action: { type: 'string', enum: ['discover', 'run'], description: 'Discover is read-only. Run executes only approved command IDs.' },
  approved_command_ids: {
    type: 'array',
    items: { type: 'string' },
    description: 'Exact command IDs from a prior discovery response.',
  },
} as const

const outputSchema = {
  type: 'object',
  additionalProperties: true,
  description: 'Versioned Release Guardian report with schema_version=1.',
} as const

function baseConfig(config: Config): Partial<GuardianConfig> {
  return {
    workspaceRoot: config.workspaceRoot,
    maxDiffBytes: config.maxDiffBytes,
    maxFiles: config.maxFiles,
    maxFindings: config.maxFindings,
    maxCheckOutputBytes: config.maxCheckOutputBytes,
    checkTimeoutMs: config.checkTimeoutMs,
    includeUntracked: config.includeUntracked,
    manifestDepth: config.manifestDepth,
    maxChecks: config.maxChecks,
  }
}

export function apply(ctx: Context, config: Config): void {
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name !== 'release_guardian_check') return await next()
    const args = exec.arguments
    if (args === null || typeof args !== 'object' || Array.isArray(args)) return await next()
    if ((args as Record<string, unknown>).action !== 'run') return await next()
    return {
      kind: 'ask',
      reason: 'Release Guardian checks execute repository code without a sandbox. Approve only after reviewing the exact command IDs from discovery.',
    }
  })
  ctx.tools.register(defineTool({
    name: 'release_guardian_check',
    description: 'Scan a Git change for release risks and discover checks. Read-only unless action=run and exact command IDs are approved.',
    parameters,
    output: {
      schema: outputSchema,
      render(_args, value) {
        const record = value
        const verdict = record.verdict as Record<string, JsonValue> | undefined
        const status = typeof verdict?.status === 'string' ? verdict.status.toUpperCase() : 'UNKNOWN'
        return [{ type: 'text', text: `Release Guardian: ${status}\n${JSON.stringify(value, null, 2)}` }]
      },
    },
    async execute(args, exec) {
      const repoPath = args.repo_path ?? resolve(config.workspaceRoot)
      if (!isAbsolute(repoPath)) throw new TypeError('repo_path must be absolute')
      const action = args.action ?? 'discover'
      const approvedInput = args.approved_command_ids ?? []
      if (approvedInput.some(id => !/^sha256:[a-f0-9]{64}$/u.test(id))) {
        throw new TypeError('approved_command_ids must contain only discovered sha256 command IDs')
      }
      const approved = [...new Set(approvedInput)]
      if (action === 'run' && approved.length === 0) {
        throw new TypeError('action=run requires at least one approved_command_ids entry from discovery')
      }
      const report = await auditRelease({
        repoPath,
        ...(args.config_path === undefined ? {} : { configPath: args.config_path }),
        ...(args.mode === undefined ? {} : { mode: args.mode as DiffMode }),
        ...(args.base === undefined ? {} : { base: args.base }),
        ...(args.head === undefined ? {} : { head: args.head }),
        ...(args.include_untracked === undefined ? {} : { includeUntracked: args.include_untracked }),
        ...(args.max_diff_bytes === undefined ? {} : { maxDiffBytes: args.max_diff_bytes }),
        ...(args.categories === undefined ? {} : { categories: args.categories as CheckCategory[] }),
        approvedCommandIds: approved,
        runApprovedChecks: action === 'run',
        signal: exec.signal,
      }, baseConfig(config))
      return toJsonReport(report) as unknown as Record<string, JsonValue>
    },
  }))
}

export { auditRelease } from './core/audit.js'
export type { AuditRequest, ReleaseReport } from './core/types.js'
