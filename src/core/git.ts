import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { minimatch } from 'minimatch'
import { isRiskCandidateLine } from './candidates.js'
import { runArgv } from './process.js'
import type { AddedLine, ChangedFile, DiffMode, DiffSnapshot, ExclusionSummary } from './types.js'

const GIT_TIMEOUT_MS = 60_000
const EXCLUSION_SAMPLE_LIMIT = 5

function exclusionPattern(path: string, patterns: readonly string[]): string | undefined {
  return patterns.find(pattern => minimatch(path, pattern, { dot: true }))
}

function summarizeExclusions(files: ReadonlyArray<{ path: string; excludedBy?: string }>): ExclusionSummary[] {
  const summaries = new Map<string, ExclusionSummary>()
  for (const file of files) {
    if (file.excludedBy === undefined) continue
    const current = summaries.get(file.excludedBy) ?? { pattern: file.excludedBy, count: 0, samplePaths: [] }
    current.count += 1
    if (current.samplePaths.length < EXCLUSION_SAMPLE_LIMIT) current.samplePaths.push(file.path)
    summaries.set(file.excludedBy, current)
  }
  return [...summaries.values()].sort((left, right) => left.pattern.localeCompare(right.pattern))
}

async function git(cwd: string, args: readonly string[], maxOutputBytes: number, signal?: AbortSignal): Promise<string> {
  const result = await runArgv(
    ['git', '-c', 'core.pager=cat', '-c', 'core.quotePath=false', ...args],
    {
      cwd,
      timeoutMs: GIT_TIMEOUT_MS,
      maxOutputBytes,
      ...(signal === undefined ? {} : { signal }),
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
        GIT_PAGER: 'cat',
        PAGER: 'cat',
      },
    },
  )
  if (result.timedOut) throw new Error(`git ${args[0] ?? ''} timed out`)
  if (result.truncated) throw new Error(`git ${args[0] ?? ''} output exceeded the scan buffer`)
  if (result.exitCode !== 0) {
    throw new Error(`git ${args[0] ?? ''} failed: ${result.stderr.trim() || `exit ${String(result.exitCode)}`}`)
  }
  return result.stdout
}

export async function resolveRepositoryRoot(path: string, signal?: AbortSignal): Promise<string> {
  const candidate = resolve(path)
  const root = (await git(candidate, ['rev-parse', '--show-toplevel'], 64 * 1024, signal)).trim()
  return await realpath(root)
}

export async function resolveHead(repoRoot: string, signal?: AbortSignal): Promise<string> {
  return (await git(repoRoot, ['rev-parse', '--verify', 'HEAD'], 64 * 1024, signal)).trim()
}

export async function resolveRevision(repoRoot: string, revision: string, signal?: AbortSignal): Promise<string> {
  return (await git(repoRoot, ['rev-parse', '--verify', revision], 64 * 1024, signal)).trim()
}

export async function resolveHeadOrNull(repoRoot: string, signal?: AbortSignal): Promise<string | null> {
  try {
    return await resolveHead(repoRoot, signal)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/Needed a single revision|unknown revision|ambiguous argument 'HEAD'/i.test(message)) return null
    throw error
  }
}

export async function resolveMergeBase(repoRoot: string, base: string, head: string, signal?: AbortSignal): Promise<string> {
  return (await git(repoRoot, ['merge-base', '--', base, head], 64 * 1024, signal)).trim()
}

export async function readTextAtRevision(
  repoRoot: string,
  revision: string,
  path: string,
  maxBytes = 1024 * 1024,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const result = await runArgv(['git', '-c', 'core.pager=cat', 'cat-file', '-p', '--', `${revision}:${path}`], {
    cwd: repoRoot,
    timeoutMs: GIT_TIMEOUT_MS,
    maxOutputBytes: maxBytes,
    ...(signal === undefined ? {} : { signal }),
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', PAGER: 'cat' },
  })
  if (result.timedOut) throw new Error('reading policy configuration from Git timed out')
  if (result.truncated) throw new Error(`policy configuration exceeds ${String(maxBytes)} bytes`)
  if (result.exitCode === 0) return result.stdout
  if (/does not exist|not a valid object name|path .* exists on disk/i.test(result.stderr)) return undefined
  throw new Error(`git cat-file failed: ${result.stderr.trim() || `exit ${String(result.exitCode)}`}`)
}

async function emptyTree(repoRoot: string, signal?: AbortSignal): Promise<string> {
  return (await git(repoRoot, ['hash-object', '-t', 'tree', '--stdin'], 64 * 1024, signal)).trim()
}

function decodeGitPath(input: string): string {
  if (!(input.startsWith('"') && input.endsWith('"'))) return input
  const body = input.slice(1, -1)
  const bytes: number[] = []
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!
    if (char !== '\\') {
      bytes.push(...Buffer.from(char))
      continue
    }
    const next = body[++index]
    if (next === undefined) break
    const escapes: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12, v: 11, '\\': 92, '"': 34 }
    if (escapes[next] !== undefined) {
      bytes.push(escapes[next]!)
      continue
    }
    if (/[0-7]/.test(next)) {
      let octal = next
      for (let count = 0; count < 2 && /[0-7]/.test(body[index + 1] ?? ''); count += 1) octal += body[++index]
      bytes.push(Number.parseInt(octal, 8))
      continue
    }
    bytes.push(...Buffer.from(next))
  }
  return Buffer.from(bytes).toString('utf8')
}

function parseNameStatus(raw: string): ChangedFile[] {
  const fields = raw.split('\0')
  const files: ChangedFile[] = []
  for (let index = 0; index < fields.length;) {
    const code = fields[index++]
    if (!code) break
    if (code.startsWith('R') || code.startsWith('C')) {
      const oldPath = fields[index++] ?? ''
      const path = fields[index++] ?? ''
      files.push({ path, oldPath, status: 'renamed', changeStatus: 'renamed', contentKind: 'text', addedLines: 0, deletedLines: 0 })
      continue
    }
    const path = fields[index++] ?? ''
    const status: ChangedFile['status'] = code === 'A'
      ? 'added'
      : code === 'D'
        ? 'deleted'
        : 'modified'
    files.push({ path, status, changeStatus: status, contentKind: 'text', addedLines: 0, deletedLines: 0 })
  }
  return files
}

function* iterateLines(raw: string): Generator<string> {
  let start = 0
  while (start <= raw.length) {
    const end = raw.indexOf('\n', start)
    if (end === -1) {
      yield raw.slice(start)
      return
    }
    yield raw.slice(start, end)
    start = end + 1
  }
}

function parsePatch(raw: string, files: ChangedFile[], orderedFiles: readonly ChangedFile[]): { addedLines: AddedLine[]; added: number; deleted: number } {
  const addedLines: AddedLine[] = []
  const byPath = new Map(files.map(file => [file.path, file]))
  let currentPath: string | undefined
  let currentOldPath: string | undefined
  let diffIndex = 0
  let newLine = 0
  let added = 0
  let deleted = 0
  for (const rawLine of iterateLines(raw)) {
    if (rawLine.startsWith('diff --git ')) {
      const next = orderedFiles[diffIndex++]
      currentPath = next !== undefined && byPath.has(next.path) ? next.path : undefined
      currentOldPath = next !== undefined && byPath.has(next.path) ? next.oldPath ?? next.path : undefined
      continue
    }
    if (rawLine.startsWith('--- ')) {
      const marker = rawLine.slice(4)
      currentOldPath = marker === '/dev/null' ? undefined : decodeGitPath(marker.startsWith('a/') ? marker.slice(2) : marker)
      continue
    }
    if (rawLine.startsWith('+++ ')) {
      const marker = rawLine.slice(4)
      currentPath = marker === '/dev/null'
        ? currentOldPath
        : decodeGitPath(marker.startsWith('b/') ? marker.slice(2) : marker)
      continue
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(rawLine)
    if (hunk !== null) {
      newLine = Number(hunk[1])
      continue
    }
    if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) {
      if (currentPath !== undefined) {
        const file = byPath.get(currentPath)
        if (file !== undefined) {
          const text = rawLine.slice(1)
          if (isRiskCandidateLine(currentPath, text)) addedLines.push({ path: currentPath, line: newLine, text })
          file.addedLines += 1
          if (file.excludedBy === undefined) added += 1
        }
      }
      newLine += 1
      continue
    }
    if (rawLine.startsWith('-') && !rawLine.startsWith('---')) {
      if (currentPath !== undefined) {
        const file = byPath.get(currentPath)
        if (file !== undefined) {
          file.deletedLines += 1
          if (file.excludedBy === undefined) deleted += 1
        }
      }
      continue
    }
    if (rawLine.startsWith('Binary files ') && currentPath !== undefined) {
      const file = byPath.get(currentPath)
      if (file !== undefined) {
        file.status = 'binary'
        file.contentKind = 'binary'
      }
    }
    if (!rawLine.startsWith('\\')) newLine += 1
  }
  return { addedLines, added, deleted }
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

async function collectUntracked(
  repoRoot: string,
  remainingBytes: number,
  remainingFiles: number,
  exclude: readonly string[],
  signal?: AbortSignal,
): Promise<{
  files: ChangedFile[]
  lines: AddedLine[]
  usedBytes: number
  truncated: boolean
  diagnostics: string[]
  candidateCount: number
  excludedCandidates: Array<{ path: string; excludedBy: string }>
  fingerprint: string
  includedAddedLines: number
}> {
  const raw = await git(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z', '--'], Math.max(64 * 1024, remainingBytes + 1), signal)
  const paths = raw.split('\0').filter(path => path.length > 0)
  const files: ChangedFile[] = []
  const lines: AddedLine[] = []
  const diagnostics: string[] = []
  const fingerprint = createHash('sha256').update(paths.join('\0'))
  const excludedCandidates = paths.flatMap(path => {
    const excludedBy = exclusionPattern(path, exclude)
    return excludedBy === undefined ? [] : [{ path, excludedBy }]
  })
  let usedBytes = 0
  let includedAddedLines = 0
  let truncated = paths.length > remainingFiles
  for (const path of paths.slice(0, remainingFiles)) {
    const excludedBy = exclusionPattern(path, exclude)
    const absolute = resolve(repoRoot, path)
    const fileStat = await lstat(absolute)
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
      diagnostics.push(`untracked path was not scanned because it is not a regular file: ${path}`)
      truncated = true
      continue
    }
    const actual = await realpath(absolute)
    if (!inside(repoRoot, actual)) {
      diagnostics.push(`untracked path escapes the repository root: ${path}`)
      truncated = true
      continue
    }
    if (fileStat.size > remainingBytes - usedBytes) {
      files.push({ path, status: 'binary', changeStatus: 'untracked', contentKind: 'uninspected', addedLines: 0, deletedLines: 0, ...(excludedBy === undefined ? {} : { excludedBy }) })
      truncated = true
      continue
    }
    const content = await readFile(actual)
    fingerprint.update('\0').update(path).update('\0').update(content)
    usedBytes += content.length
    if (content.includes(0)) {
      files.push({ path, status: 'binary', changeStatus: 'untracked', contentKind: 'binary', addedLines: 0, deletedLines: 0, ...(excludedBy === undefined ? {} : { excludedBy }) })
      continue
    }
    const text = content.toString('utf8')
    const fileLines = text.split(/\r?\n/)
    if (fileLines.at(-1) === '') fileLines.pop()
    files.push({ path, status: 'untracked', changeStatus: 'untracked', contentKind: 'text', addedLines: fileLines.length, deletedLines: 0, ...(excludedBy === undefined ? {} : { excludedBy }) })
    if (excludedBy === undefined) includedAddedLines += fileLines.length
    for (const [index, line] of fileLines.entries()) {
      if (isRiskCandidateLine(path, line)) lines.push({ path, line: index + 1, text: line })
    }
  }
  return {
    files,
    lines,
    usedBytes,
    truncated,
    diagnostics,
    candidateCount: paths.length,
    excludedCandidates,
    fingerprint: `sha256:${fingerprint.digest('hex')}`,
    includedAddedLines,
  }
}

export interface CollectDiffOptions {
  mode: DiffMode
  base?: string
  head: string
  includeUntracked: boolean
  maxBytes: number
  maxFiles: number
  exclude?: string[]
  signal?: AbortSignal
}

export async function collectDiff(repoRoot: string, options: CollectDiffOptions): Promise<DiffSnapshot> {
  const exclude = options.exclude ?? []
  let base: string | null = null
  let resolvedHead = 'unborn'
  let diffTail: string[]
  if (options.mode === 'range') {
    if (options.base === undefined || options.base.length === 0) throw new TypeError('range mode requires a base ref')
    base = await resolveMergeBase(repoRoot, options.base, options.head, options.signal)
    diffTail = [base, options.head]
  } else if (options.mode === 'staged') {
    base = await resolveHeadOrNull(repoRoot, options.signal)
    diffTail = ['--cached', base ?? await emptyTree(repoRoot, options.signal)]
  } else {
    base = await resolveHeadOrNull(repoRoot, options.signal)
    diffTail = [base ?? await emptyTree(repoRoot, options.signal)]
  }
  try {
    resolvedHead = await resolveRevision(repoRoot, options.head, options.signal)
  } catch (error) {
    if (base !== null || options.mode === 'range') throw error
  }

  const flags = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--find-renames']
  const nameStatus = await git(repoRoot, [...flags, '--name-status', '-z', ...diffTail, '--'], Math.max(options.maxBytes, options.maxFiles * 4_096), options.signal)
  const orderedFiles = parseNameStatus(nameStatus)
  for (const file of orderedFiles) {
    const excludedBy = exclusionPattern(file.path, exclude)
    if (excludedBy !== undefined) file.excludedBy = excludedBy
  }
  let files = orderedFiles
  const tooManyFiles = files.length > options.maxFiles
  if (tooManyFiles) files = files.slice(0, options.maxFiles)
  const patch = await runArgv(
    ['git', '-c', 'core.pager=cat', '-c', 'core.quotePath=false', ...flags, '--unified=0', ...diffTail, '--'],
    {
      cwd: repoRoot,
      timeoutMs: GIT_TIMEOUT_MS,
      maxOutputBytes: options.maxBytes,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', PAGER: 'cat' },
    },
  )
  if (patch.exitCode !== 0) throw new Error(`git diff failed: ${patch.stderr.trim() || `exit ${String(patch.exitCode)}`}`)
  const parsed = parsePatch(patch.stdout, files, orderedFiles)
  let addedLines = parsed.addedLines
  let added = parsed.added
  let deleted = parsed.deleted
  let truncated = tooManyFiles || patch.truncated
  const diagnostics: string[] = []
  let untrackedFingerprint = 'sha256:none'
  if (patch.truncated) diagnostics.push(`diff exceeded the ${String(options.maxBytes)} byte scan limit`)
  if (tooManyFiles) diagnostics.push(`diff exceeded the ${String(options.maxFiles)} file scan limit`)

  let filesChanged = orderedFiles.length
  const allExcludedCandidates: Array<{ path: string; excludedBy: string }> = orderedFiles.flatMap(file =>
    file.excludedBy === undefined ? [] : [{ path: file.path, excludedBy: file.excludedBy }],
  )
  if (options.mode === 'worktree' && options.includeUntracked) {
    const untracked = await collectUntracked(
      repoRoot,
      Math.max(0, options.maxBytes - Buffer.byteLength(patch.stdout)),
      options.maxFiles - files.length,
      exclude,
      options.signal,
    )
    files = [...files, ...untracked.files]
    filesChanged += untracked.candidateCount
    allExcludedCandidates.push(...untracked.excludedCandidates)
    addedLines = [...addedLines, ...untracked.lines]
    added += untracked.includedAddedLines
    truncated ||= untracked.truncated
    diagnostics.push(...untracked.diagnostics)
    untrackedFingerprint = untracked.fingerprint
    if (untracked.truncated) diagnostics.push('one or more untracked files were not fully scanned')
  }

  files.sort((a, b) => a.path.localeCompare(b.path))
  const exclusions = summarizeExclusions(allExcludedCandidates)
  const fingerprint = `sha256:${createHash('sha256')
    .update(options.mode).update('\0')
    .update(base ?? '').update('\0')
    .update(resolvedHead).update('\0')
    .update(nameStatus).update('\0')
    .update(patch.stdout).update('\0')
    .update(untrackedFingerprint)
    .digest('hex')}`
  return {
    mode: options.mode,
    base,
    head: options.head,
    files,
    addedLines,
    filesChanged,
    filesSeen: files.filter(file => file.excludedBy === undefined).length,
    filesExcluded: allExcludedCandidates.length,
    filesUnseen: Math.max(0, filesChanged - files.filter(file => file.excludedBy === undefined).length - allExcludedCandidates.length),
    exclusions,
    fingerprint,
    candidateLinesSeen: addedLines.length,
    addedLinesSeen: added,
    deletedLinesSeen: deleted,
    truncated,
    diagnostics,
  }
}
