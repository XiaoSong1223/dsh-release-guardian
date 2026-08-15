import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DSH_VERSION = '0.1.0-rc.6'
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const windows = process.platform === 'win32'

function executable(name) {
  return windows && ['npm', 'npx', 'pnpm'].includes(name) ? `${name}.cmd` : name
}

async function run(name, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 120_000
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable(name), args, {
      cwd: options.cwd ?? projectRoot,
      env: options.env ?? process.env,
      shell: windows,
      detached: !windows,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    const terminate = () => {
      try {
        if (!windows && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {
        // The process has already exited.
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      terminate()
    }, timeoutMs)
    child.stdout.on('data', chunk => { stdout += chunk.toString() })
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.on('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      rejectPromise(error)
    })
    child.on('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) resolvePromise({ stdout, stderr })
      else rejectPromise(new Error(timedOut
        ? `${name} ${args.join(' ')} timed out after ${String(timeoutMs)}ms\n${stdout}\n${stderr}`
        : `${name} ${args.join(' ')} exited ${String(code)}\n${stdout}\n${stderr}`))
    })
  })
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const scratch = await mkdtemp(join(tmpdir(), 'dsh-release-guardian-smoke-'))
try {
  const fixture = join(scratch, 'fixture')
  await mkdir(fixture)
  await run('git', ['init'], { cwd: fixture })
  await run('git', ['config', 'user.name', 'Release Guardian Smoke'], { cwd: fixture })
  await run('git', ['config', 'user.email', 'guardian-smoke@example.invalid'], { cwd: fixture })
  await writeFile(join(fixture, 'base.ts'), 'export const base = true\n')
  await run('git', ['add', 'base.ts'], { cwd: fixture })
  await run('git', ['commit', '-m', 'base'], { cwd: fixture })
  await writeFile(join(fixture, 'change.ts'), 'export const changed = true\n')

  const packed = await run('npm', ['pack', '--json', '--pack-destination', scratch])
  const packResult = JSON.parse(packed.stdout)
  const filename = packResult[0]?.filename
  assert(typeof filename === 'string', 'npm pack did not return a tarball filename')

  const profileName = 'guardian-smoke'
  const home = join(scratch, 'home')
  const profile = join(home, 'profiles', profileName)
  const dshEnv = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }
  const dsh = ['--yes', `@deepseek-ai/dsh@${DSH_VERSION}`]
  await run('npx', [...dsh, 'plugin', '--profile', profileName, 'add', join(scratch, filename)], {
    env: dshEnv,
    timeoutMs: 300_000,
  })

  const peers = await run('pnpm', ['--dir', profile, 'peers', 'check'])
  assert(peers.stdout.includes('No peer dependency issues found'), 'profile peer dependency check did not pass')

  const dump = await run('npx', [...dsh, '--profile', profileName, '--dump-config'], {
    env: dshEnv,
    timeoutMs: 300_000,
  })
  assert(dump.stdout.includes('# == dsh-release-guardian'), 'DSH did not compose the Release Guardian bundle layer')
  assert(dump.stdout.includes('name: dsh-release-guardian'), 'DSH config does not reference the packaged plugin')

  const probePath = join(profile, 'probe.mjs')
  const patchPath = join(profile, 'probe.patch.yml')
  const fixtureLiteral = JSON.stringify(fixture)
  await writeFile(probePath, `
export const name = 'release-guardian-smoke-probe'
export const inject = ['tools']
export function apply(ctx) {
  setTimeout(async () => {
    const schema = ctx.tools.schemas().find(item => item.name === 'release_guardian_check')
    if (schema === undefined) {
      process.stdout.write('DSH_TOOL_PROBE {"found":false}\\n')
      process.exit(2)
      return
    }
    const execution = await ctx.tools.execute({
      callId: 'release-guardian-dsh-smoke',
      name: 'release_guardian_check',
      arguments: { schema_version: '1', repo_path: ${fixtureLiteral}, action: 'discover', categories: [] },
      signal: new AbortController().signal,
    })
    const value = execution.value ?? {}
    const result = {
      found: true,
      isError: execution.isError,
      schemaVersion: value.schema_version ?? null,
      filesChanged: value.diff?.files_changed ?? null,
      filesUnseen: value.diff?.files_unseen ?? null,
    }
    process.stdout.write('DSH_TOOL_PROBE ' + JSON.stringify(result) + '\\n')
    process.exit(!result.isError && result.schemaVersion === '1' && result.filesChanged === 1 && result.filesUnseen === 0 ? 0 : 2)
  }, 500)
}
`)
  await writeFile(patchPath, '- insert:\n    - id: release-guardian-smoke-probe\n      name: ./probe.mjs\n')
  const boot = await run('npx', [...dsh, '--profile', profileName, '--patch', patchPath], {
    env: dshEnv,
    timeoutMs: 300_000,
  })
  const marker = boot.stdout.split(/\r?\n/u).find(line => line.startsWith('DSH_TOOL_PROBE '))
  assert(marker !== undefined, 'DSH runtime probe produced no result')
  const result = JSON.parse(marker.slice('DSH_TOOL_PROBE '.length))
  assert(result.found === true, 'release_guardian_check was not registered in DSH')
  assert(result.isError === false, 'DSH tool execution returned an error')
  assert(result.schemaVersion === '1', 'DSH tool returned an unexpected schema version')
  assert(result.filesChanged === 1 && result.filesUnseen === 0, 'DSH tool did not fully account for the fixture diff')
  process.stdout.write(`DSH smoke passed with @deepseek-ai/dsh ${DSH_VERSION}\n`)
} finally {
  await rm(scratch, { recursive: true, force: true })
}
