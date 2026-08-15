// Shared CLI resolution for the Claude Code plugin surface (bin launcher and hooks).
// Claude Code installs plugin dependencies with `npm ci --ignore-scripts`, so it never
// builds this package. Resolution therefore falls back across the install shapes that
// can legitimately provide a runnable CLI.
import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const COMMAND_NAME = 'dsh-release-guardian'

// Both `bin/` and `scripts/` sit one level below the plugin root. The bundled runner comes
// first because it is self-contained: `lib/cli.js` additionally needs installed dependencies,
// which a plugin source without a lockfile never gets.
const PLUGIN_CANDIDATES = [
  ['..', 'skills', 'release-guardian', 'scripts', 'release-guardian.mjs'],
  ['..', 'lib', 'cli.js'],
]
const WINDOWS = process.platform === 'win32'
const RECURSION_ENV_KEY = 'DSH_RELEASE_GUARDIAN_LAUNCHER'
const OVERRIDE_ENV_KEYS = ['DSH_RELEASE_GUARDIAN_CLI', 'CLAUDE_PLUGIN_OPTION_CLI_PATH', 'CLAUDE_PLUGIN_OPTION_cli_path']

function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isExecutableFile(path) {
  if (!isFile(path)) return false
  if (WINDOWS) return true
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function realPathOrNull(path) {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

function launchArgv(file) {
  return /\.[cm]?js$/u.test(file) ? [process.execPath, file] : [file]
}

function fromPath(env, selfRealPath) {
  const names = WINDOWS
    ? [`${COMMAND_NAME}.cmd`, `${COMMAND_NAME}.exe`, `${COMMAND_NAME}.bat`, COMMAND_NAME]
    : [COMMAND_NAME]
  for (const entry of (env.PATH ?? '').split(delimiter)) {
    if (entry === '') continue
    for (const name of names) {
      const candidate = join(entry, name)
      if (!isExecutableFile(candidate)) continue
      // Never re-enter this launcher through its own PATH entry.
      if (realPathOrNull(candidate) === selfRealPath) continue
      return candidate
    }
  }
  return null
}

/**
 * Resolve a runnable Release Guardian CLI.
 *
 * @param {object} options
 * @param {string} options.moduleUrl `import.meta.url` of the calling module.
 * @param {NodeJS.ProcessEnv} [options.env] Environment used for overrides and the PATH search.
 * @returns {{ argv: string[], source: 'override' | 'plugin' | 'path' } | null}
 */
export function resolveGuardianCli({ moduleUrl, env = process.env }) {
  const selfPath = fileURLToPath(moduleUrl)
  const moduleDir = dirname(selfPath)

  for (const key of OVERRIDE_ENV_KEYS) {
    const value = env[key]
    if (value === undefined || value.trim() === '') continue
    const candidate = resolve(value.trim())
    if (isFile(candidate)) return { argv: launchArgv(candidate), source: 'override' }
  }

  for (const segments of PLUGIN_CANDIDATES) {
    const candidate = resolve(moduleDir, ...segments)
    if (isFile(candidate)) return { argv: launchArgv(candidate), source: 'plugin' }
  }

  if (env[RECURSION_ENV_KEY] === '1') return null
  const onPath = fromPath(env, realPathOrNull(selfPath))
  if (onPath !== null) return { argv: launchArgv(onPath), source: 'path' }

  return null
}

/** Environment that marks a nested invocation, so a PATH lookup cannot loop. */
export function launcherEnv(env = process.env) {
  return { ...env, [RECURSION_ENV_KEY]: '1' }
}

/** Actionable message for a failed resolution; never installs anything for the user. */
export function unresolvedMessage(moduleUrl) {
  const pluginRoot = resolve(dirname(fileURLToPath(moduleUrl)), '..')
  const searched = PLUGIN_CANDIDATES.map(segments => join(pluginRoot, ...segments.slice(1))).join(', ')
  return [
    `${COMMAND_NAME}: no runnable CLI found.`,
    `Searched: ${OVERRIDE_ENV_KEYS[0]}, ${searched}, and ${COMMAND_NAME} on PATH.`,
    'Fix with one of:',
    `  - build the plugin in place: (cd ${JSON.stringify(pluginRoot)} && npm ci && npm run build)`,
    '  - install the release tarball globally: npm install --global dsh-release-guardian-<version>.tgz',
    `  - point ${OVERRIDE_ENV_KEYS[0]} (or the plugin's cli_path option) at an existing CLI`,
  ].join('\n')
}
