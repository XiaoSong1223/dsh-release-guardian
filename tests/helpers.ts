import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export async function command(cwd: string, executable: string, args: string[]): Promise<string> {
  const result = await execFileAsync(executable, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  })
  return result.stdout.trim()
}

export async function write(repo: string, path: string, content: string | Buffer): Promise<void> {
  const target = join(repo, path)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, content)
}

export async function createRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'release-guardian-test-'))
  await command(repo, 'git', ['init', '--quiet'])
  await command(repo, 'git', ['config', 'user.email', 'guardian@example.invalid'])
  await command(repo, 'git', ['config', 'user.name', 'Release Guardian Test'])
  await write(repo, 'README.md', '# fixture\n')
  await command(repo, 'git', ['add', 'README.md'])
  await command(repo, 'git', ['commit', '--quiet', '--no-gpg-sign', '-m', 'initial'])
  return repo
}

export async function createUnbornRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'release-guardian-unborn-'))
  await command(repo, 'git', ['init', '--quiet'])
  return repo
}

export async function commitAll(repo: string, message: string): Promise<string> {
  await command(repo, 'git', ['add', '-A'])
  await command(repo, 'git', ['commit', '--quiet', '--no-gpg-sign', '-m', message])
  return await command(repo, 'git', ['rev-parse', 'HEAD'])
}

export async function removeRepo(repo: string): Promise<void> {
  await rm(repo, { recursive: true, force: true })
}
