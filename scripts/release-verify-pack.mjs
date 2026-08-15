import { createHash } from 'node:crypto'
import { appendFile, chmod, lstat, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyPackageTree, verifyPackedTarball } from './verify-package.mjs'

function fail(message) {
  throw new Error(`Packed release verification failed: ${message}`)
}

function assert(condition, message) {
  if (!condition) fail(message)
}

const [packJsonArgument, assetsArgument] = process.argv.slice(2)
assert(packJsonArgument !== undefined, 'usage: release-verify-pack.mjs <npm-pack.json> [assets-directory]')

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const packJsonPath = resolve(packJsonArgument)
const assetsDirectory = resolve(assetsArgument ?? 'release-assets')
const packageJson = await verifyPackageTree(projectRoot)
const packResults = JSON.parse(await readFile(packJsonPath, 'utf8'))

assert(Array.isArray(packResults) && packResults.length === 1, 'npm pack must produce exactly one result')
const pack = packResults[0]
assert(pack !== null && typeof pack === 'object', 'npm pack returned invalid metadata')
assert(pack.name === packageJson.name, 'packed name differs from package.json')
assert(pack.version === packageJson.version, 'packed version differs from package.json')

const filenameStem = packageJson.name.replace(/^@/u, '').replaceAll('/', '-')
const expectedFilename = `${filenameStem}-${packageJson.version}.tgz`
assert(pack.filename === expectedFilename, `unexpected tarball filename: ${String(pack.filename)}`)

const assetEntries = await readdir(assetsDirectory)
const tarballEntries = assetEntries.filter(entry => entry.endsWith('.tgz'))
assert(tarballEntries.length === 1, 'release assets directory must contain exactly one tarball')
assert(tarballEntries[0] === expectedFilename, 'release assets directory contains the wrong tarball')

const tarballPath = resolve(assetsDirectory, expectedFilename)
const tarballStat = await lstat(tarballPath)
assert(tarballStat.isFile() && !tarballStat.isSymbolicLink(), 'tarball must be a regular, non-symlink file')
assert(Number.isSafeInteger(pack.size) && pack.size === tarballStat.size, 'tarball size differs from npm pack metadata')
assert(Array.isArray(pack.files) && pack.files.length > 0, 'npm pack returned no file inventory')

const packedFiles = pack.files.map(file => file.path)
assert(packedFiles.every(path => typeof path === 'string' && path.length > 0), 'npm pack file inventory is invalid')
assert(new Set(packedFiles).size === packedFiles.length, 'npm pack file inventory contains duplicates')

const verifiedEntries = await verifyPackedTarball(tarballPath, packageJson)
const archiveFiles = [...verifiedEntries.values()]
  .filter(entry => entry.type !== '5')
  .map(entry => entry.path.slice('package/'.length))
  .sort()
assert(
  JSON.stringify(archiveFiles) === JSON.stringify([...packedFiles].sort()),
  'tarball contents differ from npm pack metadata',
)

const tarball = await readFile(tarballPath)
const sha1 = createHash('sha1').update(tarball).digest('hex')
const sha512 = createHash('sha512').update(tarball).digest('base64')
const sha256 = createHash('sha256').update(tarball).digest('hex')
assert(pack.shasum === sha1, 'tarball SHA-1 differs from npm pack metadata')
assert(pack.integrity === `sha512-${sha512}`, 'tarball integrity differs from npm pack metadata')

const checksumPath = `${tarballPath}.sha256`
await writeFile(checksumPath, `${sha256}  ${basename(tarballPath)}\n`, { flag: 'wx', mode: 0o444 })
await chmod(tarballPath, 0o444)
await chmod(checksumPath, 0o444)

const workflowPath = path => relative(process.cwd(), path).split(sep).join('/')
const outputs = {
  checksum: workflowPath(checksumPath),
  checksum_name: basename(checksumPath),
  sha256,
  tarball: workflowPath(tarballPath),
  tarball_name: basename(tarballPath),
}
assert(!outputs.tarball.startsWith('../'), 'tarball must remain inside the workspace')
assert(!outputs.checksum.startsWith('../'), 'checksum must remain inside the workspace')

if (process.env.GITHUB_OUTPUT !== undefined) {
  await appendFile(
    process.env.GITHUB_OUTPUT,
    Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''),
  )
}

process.stdout.write(`Verified ${outputs.tarball}\nSHA-256 ${sha256}\n`)
