import { builtinModules } from 'node:module'
import { gunzipSync } from 'node:zlib'
import { isDeepStrictEqual } from 'node:util'
import { readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, resolve, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { minimatch } from 'minimatch'
import { parse as parseYaml } from 'yaml'

export const PACKAGE_NAME = 'dsh-release-guardian'
export const CODEX_RUNNER = 'skills/release-guardian/scripts/release-guardian.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const NODE_SHEBANG = '#!/usr/bin/env node'
const REQUIRED_PEERS = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools']
const DEPENDENCY_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
const REQUIRED_FILES_ENTRIES = [
  'lib/**/*.js',
  'lib/types/**/*.d.ts',
  'cordis.patch.yml',
  '.codex-plugin/',
  'skills/',
  'assets/',
  'README.zh-CN.md',
  'docs/',
]
const REQUIRED_ASSETS = [
  'package.json',
  'lib/index.js',
  'lib/core/index.js',
  'lib/cli.js',
  'lib/types/index.d.ts',
  'lib/types/core/index.d.ts',
  'cordis.patch.yml',
  '.codex-plugin/plugin.json',
  'skills/release-guardian/SKILL.md',
  CODEX_RUNNER,
  'assets/release-guardian.svg',
  'README.md',
  'README.zh-CN.md',
  'docs/architecture.md',
  'docs/output-schema.md',
  'docs/security-model.md',
  'docs/testing.md',
  'docs/troubleshooting.md',
  'CHANGELOG.md',
  'LICENSE',
]
const ROOT_PACK_FILES = new Set([
  'package.json',
  'cordis.patch.yml',
  'README.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'LICENSE',
])
const BUILTINS = new Set(builtinModules.flatMap(name => [name, `node:${name}`]))
const STRICT_SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u

export class PackageContractError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PackageContractError'
  }
}

function invariant(condition, message) {
  if (!condition) throw new PackageContractError(message)
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new PackageContractError(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function parseJsonBytes(bytes, label) {
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    throw new PackageContractError(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function assertVersionAgreement(packageVersion, manifestVersion) {
  invariant(typeof packageVersion === 'string', 'package.json version must be a string')
  invariant(typeof manifestVersion === 'string', '.codex-plugin/plugin.json version must be a string')
  invariant(STRICT_SEMVER.test(packageVersion), `package.json version must be strict SemVer: ${packageVersion}`)
  invariant(STRICT_SEMVER.test(manifestVersion), `.codex-plugin/plugin.json version must be strict SemVer: ${manifestVersion}`)
  const [packageBase] = packageVersion.split('+', 1)
  const [manifestBase, manifestBuild] = manifestVersion.split('+', 2)
  invariant(
    packageBase === manifestBase && (manifestBuild === undefined || /^codex(?:\.[0-9A-Za-z-]+)*$/u.test(manifestBuild)),
    `Codex manifest version ${manifestVersion} must equal package version ${packageVersion} (an optional +codex build suffix is allowed)`,
  )
}

function isForbiddenDependencySpec(spec) {
  return /(?:file|link):/iu.test(spec)
    || isAbsolute(spec)
    || win32.isAbsolute(spec)
}

export function validateDependencySpecs(packageJson, label = 'package.json') {
  for (const section of DEPENDENCY_SECTIONS) {
    const dependencies = packageJson[section]
    if (dependencies === undefined) continue
    invariant(dependencies !== null && typeof dependencies === 'object' && !Array.isArray(dependencies), `${label} ${section} must be an object`)
    for (const [name, spec] of Object.entries(dependencies)) {
      invariant(typeof spec === 'string' && spec.length > 0, `${label} ${section}.${name} must be a non-empty string`)
      invariant(!isForbiddenDependencySpec(spec), `${label} ${section}.${name} must not use a file:, link:, or absolute-path specifier: ${spec}`)
    }
  }
}

function validatePackageMetadata(packageJson, label) {
  invariant(packageJson.name === PACKAGE_NAME, `${label} name must be ${PACKAGE_NAME}`)
  invariant(typeof packageJson.version === 'string' && STRICT_SEMVER.test(packageJson.version), `${label} version must be strict SemVer`)
  invariant(packageJson.type === 'module', `${label} type must be module`)
  invariant(packageJson.main === 'lib/index.js', `${label} main must be lib/index.js`)
  invariant(packageJson.types === 'lib/types/index.d.ts', `${label} types must be lib/types/index.d.ts`)
  invariant(
    isDeepStrictEqual(packageJson.bin, { 'dsh-release-guardian': 'lib/cli.js' }),
    `${label} bin must expose dsh-release-guardian at lib/cli.js`,
  )
  invariant(packageJson.exports?.['.']?.types === './lib/types/index.d.ts', `${label} exports["."].types is invalid`)
  invariant(packageJson.exports?.['.']?.default === './lib/index.js', `${label} exports["."].default is invalid`)
  invariant(packageJson.exports?.['./core']?.types === './lib/types/core/index.d.ts', `${label} exports["./core"].types is invalid`)
  invariant(packageJson.exports?.['./core']?.default === './lib/core/index.js', `${label} exports["./core"].default is invalid`)
  invariant(packageJson.exports?.['./cordis.patch.yml'] === './cordis.patch.yml', `${label} must export ./cordis.patch.yml`)
  invariant(packageJson.exports?.['./package.json'] === './package.json', `${label} must export ./package.json`)
  invariant(packageJson.dsh?.bundle?.patch === './cordis.patch.yml', `${label} dsh.bundle.patch must be ./cordis.patch.yml`)
  invariant(Array.isArray(packageJson.files), `${label} files must be an array`)
  for (const entry of packageJson.files) {
    invariant(typeof entry === 'string' && entry.length > 0, `${label} files entries must be non-empty strings`)
    invariant(!isAbsolute(entry) && !win32.isAbsolute(entry), `${label} files entry must be relative: ${entry}`)
    invariant(!entry.includes('\\') && !entry.split('/').includes('..'), `${label} files entry is unsafe: ${entry}`)
  }
  for (const entry of REQUIRED_FILES_ENTRIES) {
    invariant(packageJson.files.includes(entry), `${label} files must include ${entry}`)
  }
  for (const peer of REQUIRED_PEERS) {
    invariant(typeof packageJson.peerDependencies?.[peer] === 'string', `${label} must declare ${peer} as a peer dependency`)
    invariant(packageJson.peerDependenciesMeta?.[peer]?.optional === true, `${label} peer ${peer} must be optional`)
  }
  for (const peer of Object.keys(packageJson.peerDependencies ?? {})) {
    if (peer === '@deepseek-ai/cordis' || peer.startsWith('@deepseek-ai/dsh-')) {
      invariant(packageJson.peerDependenciesMeta?.[peer]?.optional === true, `${label} DSH peer ${peer} must be optional`)
    }
  }
  validateDependencySpecs(packageJson, label)
}

function validatePatch(patchText, packageName, label) {
  let patch
  try {
    patch = parseYaml(patchText)
  } catch (error) {
    throw new PackageContractError(`${label} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`)
  }
  invariant(Array.isArray(patch), `${label} must be a YAML patch-layer array`)
  const insertions = patch.flatMap(layer => Array.isArray(layer?.insert) ? layer.insert : [])
  invariant(
    insertions.some(entry => entry?.id === 'release-guardian' && entry?.name === packageName),
    `${label} must insert release-guardian with package name ${packageName}`,
  )
}

function importedSpecifiers(source) {
  const specifiers = new Set()
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/gu,
    /\bimport\s*["']([^"']+)["']/gu,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/gu,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.add(match[1])
  }
  return [...specifiers]
}

function validateCodexRunner(source, label) {
  const shebangs = source.match(/^#!.*$/gmu) ?? []
  invariant(source.startsWith(`${NODE_SHEBANG}\n`), `${label} must begin with ${NODE_SHEBANG}`)
  invariant(shebangs.length === 1 && shebangs[0] === NODE_SHEBANG, `${label} must contain exactly one Node shebang`)
  const externalImports = importedSpecifiers(source).filter(specifier => !BUILTINS.has(specifier))
  invariant(
    externalImports.length === 0,
    `${label} must be self-contained; found runtime imports: ${externalImports.join(', ')}`,
  )
}

function validateManifest(manifest, packageJson, label) {
  invariant(manifest.name === packageJson.name, `${label} name must match package.json name`)
  assertVersionAgreement(packageJson.version, manifest.version)
  invariant(manifest.skills === './skills/', `${label} skills must point to ./skills/`)
  invariant(manifest.interface?.logo === './assets/release-guardian.svg', `${label} logo must point to ./assets/release-guardian.svg`)
}

function validateLockfile(lockfile, packageJson) {
  invariant(lockfile.name === packageJson.name, 'package-lock.json name must match package.json')
  invariant(lockfile.version === packageJson.version, 'package-lock.json version must match package.json')
  const root = lockfile.packages?.['']
  invariant(root?.name === packageJson.name && root?.version === packageJson.version, 'package-lock.json root package identity is stale')
  for (const section of DEPENDENCY_SECTIONS) {
    const expected = packageJson[section] ?? undefined
    const actual = root?.[section] ?? undefined
    invariant(isDeepStrictEqual(actual, expected), `package-lock.json root ${section} is stale`)
  }
}

async function assertRequiredSourceAssets(root) {
  for (const relativePath of REQUIRED_ASSETS) {
    let metadata
    try {
      metadata = await stat(resolve(root, relativePath))
    } catch {
      throw new PackageContractError(`required package asset is missing: ${relativePath}`)
    }
    invariant(metadata.isFile(), `required package asset must be a regular file: ${relativePath}`)
  }
}

export async function verifyPackageTree(root = projectRoot) {
  const packageJson = await readJson(resolve(root, 'package.json'), 'package.json')
  validatePackageMetadata(packageJson, 'package.json')
  await assertRequiredSourceAssets(root)

  const [manifest, patch, runner, lockfile] = await Promise.all([
    readJson(resolve(root, '.codex-plugin/plugin.json'), '.codex-plugin/plugin.json'),
    readFile(resolve(root, 'cordis.patch.yml'), 'utf8'),
    readFile(resolve(root, CODEX_RUNNER), 'utf8'),
    readJson(resolve(root, 'package-lock.json'), 'package-lock.json'),
  ])
  validateManifest(manifest, packageJson, '.codex-plugin/plugin.json')
  validatePatch(patch, packageJson.name, 'cordis.patch.yml')
  validateCodexRunner(runner, CODEX_RUNNER)
  validateLockfile(lockfile, packageJson)

  if (process.platform !== 'win32') {
    const runnerMode = (await stat(resolve(root, CODEX_RUNNER))).mode
    invariant((runnerMode & 0o111) !== 0, `${CODEX_RUNNER} must be executable`)
  }
  return packageJson
}

function tarString(header, offset, length) {
  const end = header.indexOf(0, offset)
  return header.subarray(offset, end === -1 || end > offset + length ? offset + length : end).toString('utf8')
}

function tarOctal(header, offset, length, label) {
  const value = tarString(header, offset, length).trim()
  invariant(/^[0-7]*$/u.test(value), `invalid tar ${label}: ${JSON.stringify(value)}`)
  return value === '' ? 0 : Number.parseInt(value, 8)
}

function parseTarball(bytes, label) {
  let tar
  try {
    tar = gunzipSync(bytes)
  } catch (error) {
    throw new PackageContractError(`${label} is not a valid gzip archive: ${error instanceof Error ? error.message : String(error)}`)
  }
  const entries = new Map()
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break

    const storedChecksum = tarOctal(header, 148, 8, 'checksum')
    const checksumHeader = Buffer.from(header)
    checksumHeader.fill(0x20, 148, 156)
    const actualChecksum = checksumHeader.reduce((sum, byte) => sum + byte, 0)
    invariant(storedChecksum === actualChecksum, `${label} contains a tar entry with an invalid checksum`)

    const name = tarString(header, 0, 100)
    const prefix = tarString(header, 345, 155)
    const path = prefix === '' ? name : `${prefix}/${name}`
    const size = tarOctal(header, 124, 12, 'entry size')
    const mode = tarOctal(header, 100, 8, 'entry mode')
    const type = String.fromCharCode(header[156] ?? 0)
    const contentStart = offset + 512
    const contentEnd = contentStart + size
    invariant(contentEnd <= tar.length, `${label} contains a truncated tar entry: ${path}`)
    invariant(!entries.has(path), `${label} contains a duplicate tar entry: ${path}`)
    invariant(type === '\0' || type === '0' || type === '5', `${label} contains unsupported non-file entry ${path} (type ${JSON.stringify(type)})`)
    entries.set(path, { path, mode, type, content: tar.subarray(contentStart, contentEnd) })
    offset = contentStart + Math.ceil(size / 512) * 512
  }
  invariant(entries.size > 0, `${label} contains no package entries`)
  return entries
}

function matchesFilesEntry(relative, filesEntry) {
  const normalized = filesEntry.startsWith('./') ? filesEntry.slice(2) : filesEntry
  if (normalized.endsWith('/')) return relative.startsWith(normalized)
  return minimatch(relative, normalized, { dot: true })
}

function validatePackedPath(entry, declaredFiles) {
  const path = entry.path
  invariant(path.startsWith('package/'), `packed entry must live under package/: ${path}`)
  invariant(!path.includes('\\'), `packed entry must use POSIX separators: ${path}`)
  const relative = path.slice('package/'.length)
  invariant(relative !== '' && !relative.split('/').includes('..'), `packed entry has an unsafe path: ${path}`)
  if (entry.type === '5') return
  const isLocalizedReadme = /^README(?:\.[0-9A-Za-z-]+)+\.md$/u.test(relative)
  invariant(
    ROOT_PACK_FILES.has(relative) || isLocalizedReadme || declaredFiles.some(filesEntry => matchesFilesEntry(relative, filesEntry)),
    `unexpected file in packed tarball: ${relative}`,
  )
  invariant(!relative.endsWith('.map'), `source maps must not be published: ${relative}`)
  invariant(!relative.startsWith('lib/') || relative.endsWith('.js') || relative.endsWith('.d.ts'), `unexpected lib artifact: ${relative}`)
}

export async function verifyPackedTarball(tarballPath, sourcePackageJson) {
  const bytes = await readFile(tarballPath)
  const entries = parseTarball(bytes, tarballPath)
  invariant(entries.has('package/package.json'), 'packed tarball is missing package.json')
  const packedPackage = parseJsonBytes(entries.get('package/package.json').content, 'packed package.json')
  validatePackageMetadata(packedPackage, 'packed package.json')
  for (const entry of entries.values()) validatePackedPath(entry, packedPackage.files)
  const packedRelativeFiles = [...entries.values()]
    .filter(entry => entry.type !== '5')
    .map(entry => entry.path.slice('package/'.length))
  for (const filesEntry of packedPackage.files) {
    invariant(
      packedRelativeFiles.some(relative => matchesFilesEntry(relative, filesEntry)),
      `package.json files entry did not resolve to a packed file: ${filesEntry}`,
    )
  }
  for (const relativePath of REQUIRED_ASSETS) {
    invariant(entries.has(`package/${relativePath}`), `packed tarball is missing required asset: ${relativePath}`)
  }

  if (sourcePackageJson !== undefined) {
    invariant(isDeepStrictEqual(packedPackage, sourcePackageJson), 'packed package.json does not match the source package.json')
  }
  const manifest = parseJsonBytes(entries.get('package/.codex-plugin/plugin.json').content, 'packed .codex-plugin/plugin.json')
  validateManifest(manifest, packedPackage, 'packed .codex-plugin/plugin.json')
  validatePatch(entries.get('package/cordis.patch.yml').content.toString('utf8'), packedPackage.name, 'packed cordis.patch.yml')
  validateCodexRunner(entries.get(`package/${CODEX_RUNNER}`).content.toString('utf8'), `packed ${CODEX_RUNNER}`)
  if (process.platform !== 'win32') {
    invariant((entries.get(`package/${CODEX_RUNNER}`).mode & 0o111) !== 0, `packed ${CODEX_RUNNER} must be executable`)
  }
  return entries
}

async function cli(args) {
  let tarballPath
  if (args.length > 0) {
    invariant(args.length === 2 && args[0] === '--tarball', 'usage: node scripts/verify-package.mjs [--tarball PATH]')
    tarballPath = resolve(args[1])
  }
  const packageJson = await verifyPackageTree(projectRoot)
  if (tarballPath !== undefined) await verifyPackedTarball(tarballPath, packageJson)
  process.stdout.write(`Package contract passed${tarballPath === undefined ? '' : ` for ${tarballPath}`}\n`)
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  cli(process.argv.slice(2)).catch(error => {
    process.stderr.write(`Package contract failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
