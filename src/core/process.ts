import { spawn } from 'node:child_process'
import type { ProcessResult } from './types.js'

export interface RunOptions {
  cwd: string
  timeoutMs: number
  maxOutputBytes: number
  signal?: AbortSignal
  env?: NodeJS.ProcessEnv
}

function appendTailBuffer(
  chunks: Buffer[],
  currentBytes: number,
  chunk: Buffer,
  maxBytes: number,
): { chunks: Buffer[]; bytes: number; truncated: boolean } {
  chunks.push(chunk)
  let bytes = currentBytes + chunk.length
  const truncated = bytes > maxBytes
  while (bytes > maxBytes && chunks.length > 0) {
    const overflow = bytes - maxBytes
    const first = chunks[0]!
    if (first.length <= overflow) {
      chunks.shift()
      bytes -= first.length
    } else {
      chunks[0] = first.subarray(overflow)
      bytes -= overflow
    }
  }
  return { chunks, bytes, truncated }
}

export async function runArgv(argv: readonly string[], options: RunOptions): Promise<ProcessResult> {
  if (argv.length === 0 || argv.some(arg => arg.length === 0)) throw new TypeError('argv must contain non-empty strings')
  const started = Date.now()
  return await new Promise<ProcessResult>((resolvePromise, rejectPromise) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    let stdoutChunks: Buffer[] = []
    let stderrChunks: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let truncated = false
    let timedOut = false
    let aborted = false
    let settled = false
    let forceKillTimer: NodeJS.Timeout | undefined

    const terminate = (): void => {
      if (child.killed) return
      try {
        if (process.platform !== 'win32' && child.pid !== undefined) process.kill(-child.pid, 'SIGTERM')
        else child.kill('SIGTERM')
      } catch {
        child.kill('SIGTERM')
      }
      forceKillTimer ??= setTimeout(() => {
        try {
          if (process.platform !== 'win32' && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
          else child.kill('SIGKILL')
        } catch {
          // The process already exited.
        }
      }, 2_000)
      forceKillTimer.unref()
    }

    const timer = setTimeout(() => {
      timedOut = true
      terminate()
    }, options.timeoutMs)
    timer.unref()
    const abort = (): void => {
      aborted = true
      terminate()
    }
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted === true) abort()

    child.stdout.on('data', (chunk: Buffer) => {
      const next = appendTailBuffer(stdoutChunks, stdoutBytes, chunk, options.maxOutputBytes)
      stdoutChunks = next.chunks
      stdoutBytes = next.bytes
      truncated ||= next.truncated
    })
    child.stderr.on('data', (chunk: Buffer) => {
      const next = appendTailBuffer(stderrChunks, stderrBytes, chunk, options.maxOutputBytes)
      stderrChunks = next.chunks
      stderrBytes = next.bytes
      truncated ||= next.truncated
    })
    child.on('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer)
      options.signal?.removeEventListener('abort', abort)
      rejectPromise(error)
    })
    child.on('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer)
      options.signal?.removeEventListener('abort', abort)
      resolvePromise({
        exitCode: code,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        durationMs: Date.now() - started,
        timedOut,
        aborted,
        truncated,
      })
    })
  })
}

export function minimalCheckEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
    'PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL',
    'SystemRoot', 'COMSPEC', 'PATHEXT', 'WINDIR', 'XDG_CACHE_HOME',
  ]
  const result: NodeJS.ProcessEnv = {
    CI: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    PAGER: 'cat',
    GIT_PAGER: 'cat',
    NO_COLOR: '1',
    GOPROXY: 'off',
    CARGO_NET_OFFLINE: 'true',
  }
  for (const key of allowed) {
    if (process.env[key] !== undefined) result[key] = process.env[key]
  }
  return result
}
