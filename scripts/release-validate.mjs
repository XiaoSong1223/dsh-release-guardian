import { appendFile, readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'

function fail(message) {
  throw new Error(`Release validation failed: ${message}`)
}

function assert(condition, message) {
  if (!condition) fail(message)
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

function gitSucceeds(...args) {
  try {
    execFileSync('git', args, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const changelog = await readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
const cliTagIndex = process.argv.indexOf('--tag')
const cliTag = cliTagIndex === -1 ? undefined : process.argv[cliTagIndex + 1]
const tag = cliTag ?? process.env.GITHUB_REF_NAME
const packageName = packageJson.name
const version = packageJson.version

assert(typeof packageName === 'string', 'package.json name must be a string')
assert(
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(packageName),
  `package name is not safe for publishing: ${String(packageName)}`,
)
assert(packageName.length <= 214, 'package name exceeds npm\'s 214-character limit')
assert(typeof version === 'string', 'package.json version must be a string')
assert(
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/u.test(version),
  `package version is not valid SemVer: ${String(version)}`,
)
assert(typeof tag === 'string' && tag.length > 0, 'a release tag is required')
assert(tag === `v${version}`, `tag ${tag} must exactly equal v${version}`)

const versionPattern = escapeRegExp(version)
const changelogHeading = new RegExp(
  `^##\\s+\\[?${versionPattern}\\]?(?:\\s+-\\s+\\d{4}-\\d{2}-\\d{2})?\\s*$`,
  'gmu',
)
const changelogMatches = [...changelog.matchAll(changelogHeading)]
assert(changelogMatches.length === 1, `CHANGELOG.md must contain exactly one level-2 heading for ${version}`)

if (process.env.GITHUB_ACTIONS === 'true') {
  const defaultBranch = process.env.GITHUB_REPOSITORY_DEFAULT_BRANCH
  assert(process.env.GITHUB_EVENT_NAME === 'push', 'publishing is allowed only for a tag push event')
  assert(process.env.GITHUB_REF_TYPE === 'tag', 'GITHUB_REF_TYPE must be tag')
  assert(process.env.GITHUB_REF === `refs/tags/${tag}`, `GITHUB_REF must exactly identify ${tag}`)
  assert(typeof defaultBranch === 'string' && defaultBranch.length > 0, 'the repository default branch is required')

  const head = git('rev-parse', 'HEAD^{commit}')
  const tagCommit = git('rev-parse', `${tag}^{commit}`)
  assert(head === tagCommit, `${tag} does not resolve to the checked-out commit`)
  if (process.env.GITHUB_SHA !== undefined) {
    assert(head === process.env.GITHUB_SHA, 'the checked-out commit does not match GITHUB_SHA')
  }
  const remoteDefaultBranch = `refs/remotes/origin/${defaultBranch}`
  assert(gitSucceeds('show-ref', '--verify', '--quiet', remoteDefaultBranch), `remote default branch is unavailable: ${remoteDefaultBranch}`)
  assert(
    gitSucceeds('merge-base', '--is-ancestor', head, remoteDefaultBranch),
    `${tag} must point to a commit contained in origin/${defaultBranch}`,
  )
  assert(git('status', '--porcelain=v1', '--untracked-files=no') === '', 'tracked working tree must be clean')
}

const outputs = {
  package_name: packageName,
  package_spec: `${packageName}@${version}`,
  tag,
  version,
}

if (process.env.GITHUB_OUTPUT !== undefined) {
  await appendFile(
    process.env.GITHUB_OUTPUT,
    Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''),
  )
}

process.stdout.write(`Validated ${outputs.package_spec} from ${tag}\n`)
