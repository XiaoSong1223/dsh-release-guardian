import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyPackageTree, verifyPackedTarball } from './verify-package.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const windows = process.platform === 'win32'

function npmPack(destination) {
  const executable = windows ? 'npm.cmd' : 'npm'
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, ['pack', '--ignore-scripts', '--json', '--pack-destination', destination], {
      cwd: projectRoot,
      shell: windows,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk.toString() })
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.on('error', rejectPromise)
    child.on('close', code => {
      if (code !== 0) {
        rejectPromise(new Error(`npm pack exited ${String(code)}\n${stdout}\n${stderr}`))
        return
      }
      try {
        const result = JSON.parse(stdout)
        const filename = result[0]?.filename
        if (typeof filename !== 'string') throw new Error('npm pack JSON did not contain a filename')
        resolvePromise(join(destination, filename))
      } catch (error) {
        rejectPromise(error)
      }
    })
  })
}

const scratch = await mkdtemp(join(tmpdir(), 'dsh-release-guardian-pack-'))
try {
  const packageJson = await verifyPackageTree(projectRoot)
  const tarballPath = await npmPack(scratch)
  const entries = await verifyPackedTarball(tarballPath, packageJson)
  const fileCount = [...entries.values()].filter(entry => entry.type !== '5').length
  process.stdout.write(`Packed package contract passed (${fileCount} files)\n`)
} finally {
  await rm(scratch, { recursive: true, force: true })
}
