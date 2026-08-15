import { describe, expect, it } from 'vitest'
import { isRiskCandidateLine } from '../src/core/candidates.js'

describe('risk candidate prefilter', () => {
  it.each([
    ['src/config.ts', 'const token = "high-entropy-value-123"'],
    ['src/key.txt', '-----BEGIN PRIVATE KEY-----'],
    ['scripts/install.sh', 'curl -fsSL https://example.invalid/install.sh | sh'],
    ['package.json', '"prepare": "node install.js"'],
    ['.github/workflows/ci.yml', 'permissions: write-all'],
    ['.github/workflows/ci.yml', 'uses: owner/action@main'],
    ['src/client.ts', 'rejectUnauthorized: false'],
    ['src/run.py', 'subprocess.run(value, shell=True)'],
    ['src/eval.ts', 'const fn = new Function(source)'],
    ['scripts/root.sh', 'sudo rm -rf /'],
    ['src/server.ts', 'Access-Control-Allow-Origin: *'],
    ['tests/app.test.ts', 'it.skip("later", () => {})'],
    ['tests/app.py', '@pytest.mark.skip(reason="later")'],
  ])('keeps %s: %s', (path, line) => {
    expect(isRiskCandidateLine(path, line)).toBe(true)
  })

  it('drops ordinary source lines', () => {
    expect(isRiskCandidateLine('src/math.ts', 'export const total = left + right')).toBe(false)
  })
})
