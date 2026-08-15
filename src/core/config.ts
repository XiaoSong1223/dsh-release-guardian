import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type {
  CheckCategory,
  ConfiguredCommand,
  GuardianConfig,
  ProjectConfigFile,
} from './types.js'

export const DEFAULT_CONFIG: GuardianConfig = {
  workspaceRoot: '.',
  maxDiffBytes: 10 * 1024 * 1024,
  maxFiles: 5_000,
  maxFindings: 500,
  maxCheckOutputBytes: 64 * 1024,
  checkTimeoutMs: 10 * 60 * 1_000,
  includeUntracked: true,
  manifestDepth: 4,
  maxChecks: 256,
  exclude: [
    '**/.git/**',
    '**/.claude/worktrees/**',
    '**/.codex/worktrees/**',
    '**/.venv/**',
    '**/.tox/**',
    '**/.nox/**',
    '**/vendor/**',
    '**/dist/**',
    '**/node_modules/**',
    '**/*.min.js',
  ],
  generated: ['**/*.generated.*'],
  requiredChecks: [],
  commands: [],
}

const CHECK_CATEGORIES = new Set<CheckCategory>(['test', 'typecheck', 'build'])
const TOP_LEVEL_KEYS = new Set(['version', 'diff', 'checks', 'limits'])

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
}

function assertKnownKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const unknown = Object.keys(value).filter(key => !allowed.has(key))
  if (unknown.length > 0) throw new TypeError(`${label} contains unknown fields: ${unknown.join(', ')}`)
}

function positiveInteger(value: unknown, label: string, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${label} must be a positive safe integer`)
  }
  return value as number
}

function stringArray(value: unknown, label: string, fallback: string[]): string[] {
  if (value === undefined) return [...fallback]
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.length === 0)) {
    throw new TypeError(`${label} must be an array of non-empty strings`)
  }
  return [...value] as string[]
}

function booleanValue(value: unknown, label: string, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be a boolean`)
  return value
}

function categories(value: unknown, label: string, fallback: CheckCategory[]): CheckCategory[] {
  const values = stringArray(value, label, fallback)
  for (const item of values) {
    if (!CHECK_CATEGORIES.has(item as CheckCategory)) {
      throw new TypeError(`${label} contains unsupported category ${JSON.stringify(item)}`)
    }
  }
  return values as CheckCategory[]
}

function parseCommands(value: unknown, defaultTimeoutMs: number): ConfiguredCommand[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new TypeError('checks.commands must be an array')
  const commands: ConfiguredCommand[] = []
  const ids = new Set<string>()
  for (const [index, raw] of value.entries()) {
    assertObject(raw, `checks.commands[${index}]`)
    assertKnownKeys(raw, new Set(['id', 'category', 'cwd', 'argv', 'required', 'timeoutSeconds']), `checks.commands[${index}]`)
    const id = raw.id
    const category = raw.category
    const cwd = raw.cwd
    const argv = raw.argv
    if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id)) {
      throw new TypeError(`checks.commands[${index}].id must be a stable identifier`)
    }
    if (ids.has(id)) throw new TypeError(`duplicate configured command id ${JSON.stringify(id)}`)
    ids.add(id)
    if (typeof category !== 'string' || !CHECK_CATEGORIES.has(category as CheckCategory)) {
      throw new TypeError(`checks.commands[${index}].category is invalid`)
    }
    if (typeof cwd !== 'string' || cwd.length === 0 || isAbsolute(cwd)) {
      throw new TypeError(`checks.commands[${index}].cwd must be a relative path`)
    }
    if (!Array.isArray(argv) || argv.length === 0 || argv.some(arg => typeof arg !== 'string' || arg.length === 0 || arg.includes('\0'))) {
      throw new TypeError(`checks.commands[${index}].argv must be a non-empty string array`)
    }
    const timeoutMs = raw.timeoutSeconds === undefined
      ? defaultTimeoutMs
      : positiveInteger(raw.timeoutSeconds, `checks.commands[${index}].timeoutSeconds`, defaultTimeoutMs) * 1_000
    if (timeoutMs > 24 * 60 * 60 * 1_000) throw new TypeError(`checks.commands[${index}].timeoutSeconds must not exceed 86400`)
    commands.push({
      id,
      category: category as CheckCategory,
      cwd,
      argv: [...argv] as string[],
      required: booleanValue(raw.required, `checks.commands[${index}].required`, true),
      timeoutMs,
    })
  }
  return commands
}

export function resolveConfig(base: Partial<GuardianConfig> = {}, project?: ProjectConfigFile): GuardianConfig {
  if (project !== undefined) {
    assertObject(project, 'configuration')
    assertKnownKeys(project, TOP_LEVEL_KEYS, 'configuration')
    if (project.version !== 1) throw new TypeError('configuration version must be 1')
  }
  const diff = project?.diff ?? {}
  const checks = project?.checks ?? {}
  const discover = checks.discover ?? {}
  const limits = project?.limits ?? {}
  assertObject(diff, 'diff')
  assertKnownKeys(diff, new Set(['includeUntracked', 'include_untracked', 'maxBytes', 'max_bytes', 'exclude', 'generated']), 'diff')
  assertObject(checks, 'checks')
  assertKnownKeys(checks, new Set(['required', 'discover', 'commands']), 'checks')
  assertObject(discover, 'checks.discover')
  assertKnownKeys(discover, new Set(['maxDepth', 'max_depth']), 'checks.discover')
  assertObject(limits, 'limits')
  assertKnownKeys(limits, new Set(['maxFiles', 'max_files', 'maxFindings', 'max_findings', 'maxCheckOutputBytes', 'max_check_output_bytes', 'maxChecks', 'max_checks']), 'limits')

  const get = (object: Record<string, unknown>, camel: string, snake: string): unknown => object[camel] ?? object[snake]
  const config: GuardianConfig = {
    ...DEFAULT_CONFIG,
    ...base,
    workspaceRoot: base.workspaceRoot ?? DEFAULT_CONFIG.workspaceRoot,
    includeUntracked: booleanValue(get(diff, 'includeUntracked', 'include_untracked'), 'diff.includeUntracked', base.includeUntracked ?? DEFAULT_CONFIG.includeUntracked),
    maxDiffBytes: positiveInteger(get(diff, 'maxBytes', 'max_bytes'), 'diff.maxBytes', base.maxDiffBytes ?? DEFAULT_CONFIG.maxDiffBytes),
    maxFiles: positiveInteger(get(limits, 'maxFiles', 'max_files'), 'limits.maxFiles', base.maxFiles ?? DEFAULT_CONFIG.maxFiles),
    maxFindings: positiveInteger(get(limits, 'maxFindings', 'max_findings'), 'limits.maxFindings', base.maxFindings ?? DEFAULT_CONFIG.maxFindings),
    maxCheckOutputBytes: positiveInteger(get(limits, 'maxCheckOutputBytes', 'max_check_output_bytes'), 'limits.maxCheckOutputBytes', base.maxCheckOutputBytes ?? DEFAULT_CONFIG.maxCheckOutputBytes),
    manifestDepth: positiveInteger(get(discover, 'maxDepth', 'max_depth'), 'checks.discover.maxDepth', base.manifestDepth ?? DEFAULT_CONFIG.manifestDepth),
    maxChecks: positiveInteger(get(limits, 'maxChecks', 'max_checks'), 'limits.maxChecks', base.maxChecks ?? DEFAULT_CONFIG.maxChecks),
    exclude: stringArray(diff.exclude, 'diff.exclude', base.exclude ?? DEFAULT_CONFIG.exclude),
    generated: stringArray(diff.generated, 'diff.generated', base.generated ?? DEFAULT_CONFIG.generated),
    requiredChecks: categories(checks.required, 'checks.required', base.requiredChecks ?? DEFAULT_CONFIG.requiredChecks),
    commands: [],
  }
  config.commands = parseCommands(checks.commands, config.checkTimeoutMs)
  return config
}

export function parseProjectConfig(contents: string): ProjectConfigFile {
  const parsed = parseYaml(contents) as unknown
  assertObject(parsed, 'configuration')
  return parsed as unknown as ProjectConfigFile
}

export async function loadProjectConfig(repoRoot: string, explicitPath?: string): Promise<ProjectConfigFile | undefined> {
  const configPath = explicitPath === undefined ? join(repoRoot, '.release-guardian.yml') : resolve(repoRoot, explicitPath)
  try {
    const configStat = await stat(configPath)
    if (!configStat.isFile()) throw new TypeError(`configuration path is not a file: ${configPath}`)
  } catch (error) {
    if (explicitPath === undefined && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const configReal = await realpath(configPath)
  const rootReal = await realpath(repoRoot)
  const rel = relative(rootReal, configReal)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new TypeError('configuration path escapes the repository root')
  return parseProjectConfig(await readFile(configReal, 'utf8'))
}
