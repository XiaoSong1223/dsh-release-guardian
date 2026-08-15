import { chmod, mkdir, readFile } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const entryPoint = resolve(projectRoot, 'src/cli.ts')
const outfile = resolve(projectRoot, 'skills/release-guardian/scripts/release-guardian.mjs')
const shebang = '#!/usr/bin/env node'

await mkdir(dirname(outfile), { recursive: true })
const result = await build({
  entryPoints: [entryPoint],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  packages: 'bundle',
  banner: {
    js: "import { createRequire as __dshCreateRequire } from 'node:module';\nconst require = __dshCreateRequire(import.meta.url);",
  },
  legalComments: 'none',
  sourcemap: false,
  charset: 'utf8',
  logLevel: 'info',
  metafile: true,
})

const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]))
const runtimePackages = Object.values(result.metafile.outputs)
  .flatMap(output => output.imports)
  .filter(imported => imported.external && !builtins.has(imported.path))
  .map(imported => imported.path)
if (runtimePackages.length > 0) {
  throw new Error(`Codex CLI bundle has external runtime packages: ${[...new Set(runtimePackages)].join(', ')}`)
}

const output = await readFile(outfile, 'utf8')
const shebangLines = output.split(/\r?\n/u).filter(line => line.startsWith('#!'))
if (!output.startsWith(`${shebang}\n`) || shebangLines.length !== 1 || shebangLines[0] !== shebang) {
  throw new Error('Codex CLI bundle must preserve exactly one Node shebang')
}

if (process.platform !== 'win32') await chmod(outfile, 0o755)
