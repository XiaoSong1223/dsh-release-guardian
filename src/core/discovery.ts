import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { minimatch } from 'minimatch'
import { runArgv } from './process.js'
import type {
  CheckCategory,
  CheckPlan,
  ConfiguredCommand,
  GuardianConfig,
} from './types.js'

interface Manifest {
  relativePath: string
  cwd: string
  relativeCwd: string
  name: string
  bytes: Buffer
  fingerprint: string
}

interface Candidate {
  plan: CheckPlan
  cwdDepth: number
  relativeCwd: string
  manifestPath: string
  categoryOrder: number
  sequence: number
}

export interface CheckDiscoveryResult {
  plans: CheckPlan[]
  complete: boolean
  candidatesSeen: number
  checksReturned: number
  limit: number
  truncated: boolean
  diagnostics: string[]
  warnings: string[]
}

type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

const MANIFEST_NAMES = new Set([
  'package.json',
  'pyproject.toml',
  'pytest.ini',
  'tox.ini',
  'mypy.ini',
  'go.mod',
  'Cargo.toml',
  'pom.xml',
])

const LOCK_FILES: ReadonlyArray<readonly [string, PackageManager]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
]

const INTRINSIC_DISCOVERY_EXCLUDE = [
  '**/.git/**',
  '**/.claude/worktrees/**',
  '**/.codex/worktrees/**',
  '**/.venv/**',
  '**/venv/**',
  '**/.tox/**',
  '**/.nox/**',
  '**/node_modules/**',
  '**/vendor/**',
  '**/dist/**',
] as const
const MAX_MANIFEST_BYTES = 1024 * 1024
const DISCOVERY_GIT_OUTPUT_BYTES = 64 * 1024 * 1024

function sha256(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function slashPath(value: string): string {
  return value.split(sep).join('/')
}

function relativeToRoot(repoRoot: string, path: string): string | undefined {
  const result = relative(repoRoot, path)
  if (result === '') return '.'
  if (isAbsolute(result) || result === '..' || result.startsWith(`..${sep}`)) return undefined
  return slashPath(result)
}

function isManifestName(name: string): boolean {
  const lower = name.toLowerCase()
  return MANIFEST_NAMES.has(name)
    || name === 'build.gradle'
    || name.startsWith('build.gradle.')
    || lower.endsWith('.sln')
    || lower.endsWith('.csproj')
}

function isExcluded(relativePath: string, patterns: readonly string[], directory: boolean): boolean {
  const normalized = slashPath(relativePath).replace(/^\.\//u, '')
  if (normalized === '' || normalized === '.') return false
  const candidates = directory ? [normalized, `${normalized}/`] : [normalized]
  return patterns.some(rawPattern => {
    const pattern = slashPath(rawPattern).replace(/^\.\//u, '').replace(/^\/+/, '')
    if (pattern.length === 0) return false
    if (pattern.endsWith('/**') && normalized === pattern.slice(0, -3).replace(/\/$/u, '')) return true
    return candidates.some(candidate => minimatch(candidate, pattern, {
      dot: true,
      nocase: process.platform === 'win32',
      nonegate: true,
    }))
  })
}

function cwdDepth(relativeCwd: string): number {
  return relativeCwd === '.' ? 0 : relativeCwd.split('/').length
}

function commandId(relativeCwd: string, argv: readonly string[], manifestFingerprint: string): string {
  return sha256(`${relativeCwd}\0${argv.join('\0')}\0${manifestFingerprint}`)
}

function commandKey(category: CheckCategory, cwd: string, argv: readonly string[]): string {
  return `${category}\0${cwd}\0${argv.join('\0')}`
}

function configuredFingerprint(command: ConfiguredCommand): string {
  return sha256(JSON.stringify({
    id: command.id,
    category: command.category,
    cwd: slashPath(command.cwd),
    argv: command.argv,
    required: command.required,
  }))
}

async function containedFile(path: string, repoRoot: string, visiblePaths?: ReadonlySet<string>): Promise<boolean> {
  try {
    const requestedRelative = relativeToRoot(repoRoot, path)
    if (visiblePaths !== undefined && (requestedRelative === undefined || !visiblePaths.has(requestedRelative))) return false
    const resolved = await realpath(path)
    if (relativeToRoot(repoRoot, resolved) === undefined) return false
    return (await stat(resolved)).isFile()
  } catch {
    return false
  }
}

async function gitVisiblePaths(repoRoot: string, diagnostics: string[]): Promise<Set<string> | undefined> {
  const result = await runArgv(['git', '-c', 'core.quotePath=false', 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--'], {
    cwd: repoRoot,
    timeoutMs: 60_000,
    maxOutputBytes: DISCOVERY_GIT_OUTPUT_BYTES,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', PAGER: 'cat' },
  })
  if (result.timedOut) {
    diagnostics.push('Git-visible check discovery timed out')
    return new Set()
  }
  if (result.truncated) {
    diagnostics.push(`Git-visible check discovery exceeded ${String(DISCOVERY_GIT_OUTPUT_BYTES)} bytes`)
    return new Set()
  }
  if (result.exitCode !== 0) {
    if (/not a git repository/i.test(result.stderr)) return undefined
    diagnostics.push(`Could not enumerate Git-visible files during check discovery (${result.stderr.trim() || `exit ${String(result.exitCode)}`})`)
    return new Set()
  }
  return new Set(result.stdout.split('\0').filter(Boolean).map(slashPath))
}

async function scanGitVisibleManifests(
  repoRoot: string,
  paths: ReadonlySet<string>,
  maxDepth: number,
  exclude: readonly string[],
  diagnostics: string[],
): Promise<Manifest[]> {
  const manifests: Manifest[] = []
  const visited = new Set<string>()
  for (const relativePath of [...paths].sort((left, right) => left.localeCompare(right, 'en'))) {
    const name = basename(relativePath)
    if (!isManifestName(name) || isExcluded(relativePath, exclude, false)) continue
    const relativeCwd = slashPath(dirname(relativePath)) === '.' ? '.' : slashPath(dirname(relativePath))
    if (cwdDepth(relativeCwd) > maxDepth) continue
    const requestedPath = join(repoRoot, relativePath)
    let manifestPath: string
    let bytes: Buffer
    try {
      manifestPath = await realpath(requestedPath)
      const manifestRelative = relativeToRoot(repoRoot, manifestPath)
      if (manifestRelative === undefined) {
        diagnostics.push(`Skipped Git-visible manifest outside repository during check discovery: ${relativePath}`)
        continue
      }
      const manifestStat = await stat(manifestPath)
      if (!manifestStat.isFile()) continue
      if (manifestStat.size > MAX_MANIFEST_BYTES) {
        diagnostics.push(`Manifest exceeds ${String(MAX_MANIFEST_BYTES)} bytes during check discovery: ${relativePath}`)
        continue
      }
      if (visited.has(manifestPath)) continue
      bytes = await readFile(manifestPath)
    } catch (error) {
      diagnostics.push(`Could not read Git-visible manifest during check discovery: ${relativePath} (${errorMessage(error)})`)
      continue
    }
    visited.add(manifestPath)
    const cwd = dirname(manifestPath)
    const actualRelativeCwd = relativeToRoot(repoRoot, cwd)
    if (actualRelativeCwd === undefined) continue
    manifests.push({ relativePath, cwd, relativeCwd: actualRelativeCwd, name, bytes, fingerprint: sha256(bytes) })
  }
  return manifests.sort((left, right) => {
    const depthDifference = cwdDepth(left.relativeCwd) - cwdDepth(right.relativeCwd)
    if (depthDifference !== 0) return depthDifference
    const cwdDifference = left.relativeCwd.localeCompare(right.relativeCwd, 'en')
    if (cwdDifference !== 0) return cwdDifference
    return left.relativePath.localeCompare(right.relativePath, 'en')
  })
}

async function scanManifests(
  repoRoot: string,
  maxDepth: number,
  exclude: readonly string[],
  diagnostics: string[],
  warnings: string[],
): Promise<Manifest[]> {
  const manifests: Manifest[] = []
  const visitedDirectories = new Set<string>()
  const visitedManifests = new Set<string>()

  const walk = async (requestedDirectory: string, depth: number): Promise<void> => {
    let directory: string
    try {
      directory = await realpath(requestedDirectory)
      if (relativeToRoot(repoRoot, directory) === undefined) {
        warnings.push(`Skipped path outside repository during check discovery: ${requestedDirectory}`)
        return
      }
      if (!(await stat(directory)).isDirectory() || visitedDirectories.has(directory)) return
    } catch (error) {
      diagnostics.push(`Could not inspect directory during check discovery: ${requestedDirectory} (${errorMessage(error)})`)
      return
    }
    visitedDirectories.add(directory)

    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      diagnostics.push(`Could not read directory during check discovery: ${directory} (${errorMessage(error)})`)
      return
    }
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))

    for (const entry of entries) {
      const requestedPath = join(directory, entry.name)
      const requestedRelative = relativeToRoot(repoRoot, requestedPath)
      if (requestedRelative === undefined) continue
      const mightBeDirectory = entry.isDirectory() || entry.isSymbolicLink()
      if (isExcluded(requestedRelative, exclude, mightBeDirectory)) continue

      if (entry.isDirectory()) {
        if (depth < maxDepth) await walk(requestedPath, depth + 1)
        continue
      }

      if (entry.isSymbolicLink()) {
        let target: string
        let targetStat
        try {
          target = await realpath(requestedPath)
          const targetRelative = relativeToRoot(repoRoot, target)
          if (targetRelative === undefined) {
            const message = `Skipped symlink outside repository during check discovery: ${requestedRelative}`
            if (isManifestName(entry.name)) diagnostics.push(message)
            else warnings.push(message)
            continue
          }
          targetStat = await stat(target)
          if (isExcluded(targetRelative, exclude, targetStat.isDirectory())) continue
        } catch (error) {
          diagnostics.push(`Could not resolve symlink during check discovery: ${requestedRelative} (${errorMessage(error)})`)
          continue
        }
        if (targetStat.isDirectory()) {
          if (depth < maxDepth) await walk(target, depth + 1)
          continue
        }
        if (!targetStat.isFile() || !isManifestName(entry.name)) continue
      } else if (!entry.isFile() || !isManifestName(entry.name)) {
        continue
      }

      let manifestPath: string
      let bytes: Buffer
      try {
        manifestPath = await realpath(requestedPath)
        const manifestRelative = relativeToRoot(repoRoot, manifestPath)
        if (manifestRelative === undefined) {
          warnings.push(`Skipped manifest outside repository during check discovery: ${requestedRelative}`)
          continue
        }
        const manifestStat = await stat(manifestPath)
        if (visitedManifests.has(manifestPath) || !manifestStat.isFile()) continue
        if (manifestStat.size > MAX_MANIFEST_BYTES) {
          diagnostics.push(`Manifest exceeds ${String(MAX_MANIFEST_BYTES)} bytes during check discovery: ${requestedRelative}`)
          continue
        }
        bytes = await readFile(manifestPath)
      } catch (error) {
        diagnostics.push(`Could not read manifest during check discovery: ${requestedRelative} (${errorMessage(error)})`)
        continue
      }

      const manifestCwd = dirname(manifestPath)
      const relativeCwd = relativeToRoot(repoRoot, manifestCwd)
      const relativePath = relativeToRoot(repoRoot, manifestPath)
      if (relativeCwd === undefined || relativePath === undefined) continue
      visitedManifests.add(manifestPath)
      manifests.push({
        relativePath,
        cwd: manifestCwd,
        relativeCwd,
        name: entry.name,
        bytes,
        fingerprint: sha256(bytes),
      })
    }
  }

  await walk(repoRoot, 0)
  return manifests.sort((left, right) => {
    const depthDifference = cwdDepth(left.relativeCwd) - cwdDepth(right.relativeCwd)
    if (depthDifference !== 0) return depthDifference
    const cwdDifference = left.relativeCwd.localeCompare(right.relativeCwd, 'en')
    if (cwdDifference !== 0) return cwdDifference
    return left.relativePath.localeCompare(right.relativePath, 'en')
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function packageManagerFromField(value: unknown): PackageManager | undefined {
  if (typeof value !== 'string') return undefined
  const name = value.split('@', 1)[0]
  if (name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'bun') return name
  return undefined
}

async function detectPackageManager(
  cwd: string,
  repoRoot: string,
  packageManagerField: unknown,
  visiblePaths?: ReadonlySet<string>,
): Promise<PackageManager> {
  let current = cwd
  while (relativeToRoot(repoRoot, current) !== undefined) {
    for (const [lockName, manager] of LOCK_FILES) {
      if (await containedFile(join(current, lockName), repoRoot, visiblePaths)) return manager
    }
    if (current === repoRoot) break
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return packageManagerFromField(packageManagerField) ?? 'npm'
}

function packageScriptArgv(manager: PackageManager, script: string): string[] {
  switch (manager) {
    case 'pnpm': return ['pnpm', '--offline', 'run', script]
    case 'yarn': return ['yarn', '--offline', 'run', script]
    case 'bun': return ['bun', 'run', script]
    case 'npm': return ['npm', '--offline', 'run', script]
  }
}

async function wrapperCommand(cwd: string, unixName: string, windowsName: string, fallback: string, repoRoot: string, visiblePaths?: ReadonlySet<string>): Promise<string> {
  if (process.platform === 'win32' && await containedFile(join(cwd, windowsName), repoRoot, visiblePaths)) return `.\\${windowsName}`
  if (await containedFile(join(cwd, unixName), repoRoot, visiblePaths)) return `./${unixName}`
  return fallback
}

function sectionPresent(text: string, section: string): boolean {
  const escaped = section.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(`^\\s*\\[${escaped}(?:\\.|\\])`, 'imu').test(text)
}

function safeProjectArgument(name: string): string {
  return name.startsWith('.') ? name : `./${name}`
}

async function pythonCommand(cwd: string, repoRoot: string): Promise<string> {
  const executableNames = process.platform === 'win32'
    ? ['.venv/Scripts/python.exe', 'venv/Scripts/python.exe']
    : ['.venv/bin/python', 'venv/bin/python']
  let current = cwd
  while (relativeToRoot(repoRoot, current) !== undefined) {
    for (const executableName of executableNames) {
      const candidate = join(current, ...executableName.split('/'))
      try {
        if (!(await stat(candidate)).isFile()) continue
        await access(candidate, constants.X_OK)
        const relativeExecutable = slashPath(relative(cwd, candidate))
        return relativeExecutable.startsWith('../') || relativeExecutable.startsWith('./')
          ? relativeExecutable
          : `./${relativeExecutable}`
      } catch {
        // Try the next conventional project-local environment.
      }
    }
    if (current === repoRoot) break
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return 'python'
}

/**
 * Discover candidate quality checks without executing repository code.
 */
export async function discoverChecksDetailed(
  repoRoot: string,
  config: GuardianConfig,
  categories: CheckCategory[],
): Promise<CheckDiscoveryResult> {
  const diagnostics: string[] = []
  const warnings: string[] = []
  const limit = Number.isSafeInteger(config.maxChecks) && config.maxChecks >= 0 ? config.maxChecks : 0
  if (categories.length === 0) {
    return { plans: [], complete: true, candidatesSeen: 0, checksReturned: 0, limit, truncated: false, diagnostics, warnings }
  }
  const rootReal = await realpath(repoRoot)
  if (!(await stat(rootReal)).isDirectory()) throw new TypeError(`repository root is not a directory: ${repoRoot}`)

  const requestedCategories = new Set(categories)
  const categoryOrder = new Map<CheckCategory, number>()
  categories.forEach((category, index) => {
    if (!categoryOrder.has(category)) categoryOrder.set(category, index)
  })
  const requiredCategories = new Set(config.requiredChecks)
  const configuredCandidates: Candidate[] = []
  const discoveredCandidates: Candidate[] = []
  const seenCommands = new Set<string>()
  let sequence = 0

  const addCandidate = (
    target: Candidate[],
    category: CheckCategory,
    cwd: string,
    relativeCwd: string,
    argv: string[],
    detectedBy: string,
    required: boolean,
    fingerprint: string,
    manifestPath: string,
    timeoutMs?: number,
  ): void => {
    if (!requestedCategories.has(category) || argv.length === 0 || argv.some(argument => argument.length === 0)) return
    const key = commandKey(category, relativeCwd, argv)
    if (seenCommands.has(key)) return
    seenCommands.add(key)
    target.push({
      plan: {
        id: commandId(relativeCwd, argv, fingerprint),
        category,
        cwd: relativeCwd,
        argv,
        detectedBy,
        required,
        manifestFingerprint: fingerprint,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      },
      cwdDepth: cwdDepth(relativeCwd),
      relativeCwd,
      manifestPath,
      categoryOrder: categoryOrder.get(category) ?? Number.MAX_SAFE_INTEGER,
      sequence: sequence++,
    })
  }

  for (const command of config.commands) {
    if (!requestedCategories.has(command.category)) continue
    if (command.argv.length === 0 || command.argv.some(argument => typeof argument !== 'string' || argument.length === 0)) {
      diagnostics.push(`Skipped configured check ${JSON.stringify(command.id)} because argv is invalid`)
      continue
    }
    const requestedCwd = resolve(rootReal, command.cwd)
    let cwd: string
    try {
      cwd = await realpath(requestedCwd)
      const relativeCwd = relativeToRoot(rootReal, cwd)
      if (relativeCwd === undefined) {
        diagnostics.push(`Skipped configured check ${JSON.stringify(command.id)} because cwd escapes the repository`)
        continue
      }
      if (!(await stat(cwd)).isDirectory()) {
        diagnostics.push(`Skipped configured check ${JSON.stringify(command.id)} because cwd is not a directory`)
        continue
      }
      const fingerprint = configuredFingerprint(command)
      addCandidate(
        configuredCandidates,
        command.category,
        cwd,
        relativeCwd,
        [...command.argv],
        `configured:${command.id}`,
        command.required,
        fingerprint,
        `configured:${command.id}`,
        command.timeoutMs,
      )
    } catch (error) {
      diagnostics.push(`Skipped configured check ${JSON.stringify(command.id)} because cwd could not be resolved (${errorMessage(error)})`)
    }
  }

  const discoveryExclude = [...INTRINSIC_DISCOVERY_EXCLUDE, ...config.exclude]
  const visiblePaths = await gitVisiblePaths(rootReal, diagnostics)
  const manifests = visiblePaths === undefined
    ? await scanManifests(rootReal, config.manifestDepth, discoveryExclude, diagnostics, warnings)
    : await scanGitVisibleManifests(rootReal, visiblePaths, config.manifestDepth, discoveryExclude, diagnostics)
  for (const manifest of manifests) {
    const required = (category: CheckCategory): boolean => requiredCategories.has(category)
    const detectedBy = (detail?: string): string => detail === undefined
      ? manifest.relativePath
      : `${manifest.relativePath}#${detail}`
    const add = (category: CheckCategory, argv: string[], detail?: string): void => {
      addCandidate(
        discoveredCandidates,
        category,
        manifest.cwd,
        manifest.relativeCwd,
        argv,
        detectedBy(detail),
        required(category),
        manifest.fingerprint,
        manifest.relativePath,
      )
    }

    if (manifest.name === 'package.json') {
      let parsed: unknown
      try {
        parsed = JSON.parse(manifest.bytes.toString('utf8')) as unknown
      } catch (error) {
        diagnostics.push(`Could not parse ${manifest.relativePath} during check discovery (${errorMessage(error)})`)
        continue
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        diagnostics.push(`Could not use ${manifest.relativePath} during check discovery (root value is not an object)`)
        continue
      }
      const packageRecord = parsed as Record<string, unknown>
      const scriptsValue = packageRecord.scripts
      if (scriptsValue === null || typeof scriptsValue !== 'object' || Array.isArray(scriptsValue)) continue
      const scripts = scriptsValue as Record<string, unknown>
      const manager = await detectPackageManager(manifest.cwd, rootReal, packageRecord.packageManager, visiblePaths)
      for (const category of categories) {
        if ((category === 'test' || category === 'typecheck' || category === 'build')
          && typeof scripts[category] === 'string'
          && scripts[category].length > 0) {
          add(category, packageScriptArgv(manager, category), `scripts.${category}`)
        }
      }
      continue
    }

    if (manifest.name === 'pyproject.toml') {
      const text = manifest.bytes.toString('utf8')
      const python = await pythonCommand(manifest.cwd, rootReal)
      if (sectionPresent(text, 'tool.pytest')) add('test', [python, '-m', 'pytest'], 'tool.pytest')
      if (sectionPresent(text, 'tool.mypy')) add('typecheck', [python, '-m', 'mypy', '.'], 'tool.mypy')
      if (sectionPresent(text, 'build-system')) add('build', [python, '-m', 'build', '--no-isolation'], 'build-system')
      continue
    }
    if (manifest.name === 'pytest.ini') {
      add('test', [await pythonCommand(manifest.cwd, rootReal), '-m', 'pytest'])
      continue
    }
    if (manifest.name === 'tox.ini') {
      add('test', [await pythonCommand(manifest.cwd, rootReal), '-m', 'tox', '--no-provision'])
      continue
    }
    if (manifest.name === 'mypy.ini') {
      add('typecheck', [await pythonCommand(manifest.cwd, rootReal), '-m', 'mypy', '.'])
      continue
    }
    if (manifest.name === 'go.mod') {
      add('test', ['go', 'test', '-mod=readonly', './...'])
      add('typecheck', ['go', 'vet', '-mod=readonly', './...'])
      add('build', ['go', 'build', '-mod=readonly', './...'])
      continue
    }
    if (manifest.name === 'Cargo.toml') {
      add('test', ['cargo', 'test', '--offline', '--workspace', '--all-targets'])
      add('typecheck', ['cargo', 'check', '--offline', '--workspace', '--all-targets'])
      add('build', ['cargo', 'build', '--offline', '--workspace', '--all-targets'])
      continue
    }
    if (manifest.name === 'pom.xml') {
      const maven = await wrapperCommand(manifest.cwd, 'mvnw', 'mvnw.cmd', 'mvn', rootReal, visiblePaths)
      add('test', [maven, '--offline', 'test'])
      add('build', [maven, '--offline', '-DskipTests', 'package'])
      continue
    }
    if (manifest.name === 'build.gradle' || manifest.name.startsWith('build.gradle.')) {
      const gradle = await wrapperCommand(manifest.cwd, 'gradlew', 'gradlew.bat', 'gradle', rootReal, visiblePaths)
      add('test', [gradle, '--offline', '--no-daemon', 'test'])
      add('build', [gradle, '--offline', '--no-daemon', 'assemble'])
      continue
    }
    const lowerName = manifest.name.toLowerCase()
    if (lowerName.endsWith('.sln') || lowerName.endsWith('.csproj')) {
      const project = safeProjectArgument(manifest.name)
      add('test', ['dotnet', 'test', project, '--no-restore'])
      add('build', ['dotnet', 'build', project, '--no-restore'])
    }
  }

  discoveredCandidates.sort((left, right) => {
    const depthDifference = left.cwdDepth - right.cwdDepth
    if (depthDifference !== 0) return depthDifference
    const cwdDifference = left.relativeCwd.localeCompare(right.relativeCwd, 'en')
    if (cwdDifference !== 0) return cwdDifference
    const categoryDifference = left.categoryOrder - right.categoryOrder
    if (categoryDifference !== 0) return categoryDifference
    const manifestDifference = left.manifestPath.localeCompare(right.manifestPath, 'en')
    if (manifestDifference !== 0) return manifestDifference
    return left.sequence - right.sequence
  })

  const plans = [...configuredCandidates, ...discoveredCandidates].map(candidate => candidate.plan)
  const truncated = plans.length > limit
  if (truncated) {
    diagnostics.push(`Check discovery exceeded maxChecks=${limit}; truncated from ${plans.length} checks`)
  }
  const returnedPlans = truncated ? plans.slice(0, limit) : plans
  return {
    plans: returnedPlans,
    complete: diagnostics.length === 0,
    candidatesSeen: plans.length,
    checksReturned: returnedPlans.length,
    limit,
    truncated,
    diagnostics,
    warnings,
  }
}

export async function discoverChecks(
  repoRoot: string,
  config: GuardianConfig,
  categories: CheckCategory[],
  diagnostics: string[],
  warnings: string[] = [],
): Promise<CheckPlan[]> {
  const result = await discoverChecksDetailed(repoRoot, config, categories)
  diagnostics.push(...result.diagnostics)
  warnings.push(...result.warnings)
  return result.plans
}
