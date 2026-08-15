const GENERAL_RISK_CANDIDATE = /(?:\b(?:AKIA|ASIA)[A-Z0-9]{8,}|\bgh[pousr]_|\bgithub_pat_|\bxox[baprs]-|\bsk_live_|\bAIza|PRIVATE KEY|\bBearer\s+|\b(?:password|passwd|token|secret|api[_-]?key)\b|:\/\/[^\s:@/]{2,}:[^\s@/]{4,}@|\b(?:curl|wget|base64)\b|rejectUnauthorized|\bverify\s*[:=]|verify_ssl|ssl_verify|tls_verify|NODE_TLS_REJECT_UNAUTHORIZED|\bshell\s*=|\bos\.system\s*\(|child_process\.|Runtime\.getRuntime|\beval\s*\(|\bnew\s+Function\s*\(|ScriptEngineManager|\bexec\s*\(|\bchmod\b|\bsudo\b|\bprivileged\s*:|docker\.sock|\bsetuid\s*\(|\brm\s+-rf\b|\bDROP\s+(?:DATABASE|TABLE)\b|\bgit\s+push\b|\bterraform\s+destroy\b|Access-Control-Allow-Origin|\bcors\s*\(|\bauth\w*\s*[:=]\s*(?:false|disabled)|\bEffect\s*:\s*['"]Allow)/i

/**
 * Cheap, deliberately broad prefilter for added lines. Every line-level rule must
 * have a matching term here; false positives cost only CPU, false negatives would
 * be a coverage bug and are protected by integration fixtures.
 */
export function isRiskCandidateLine(path: string, text: string): boolean {
  if (GENERAL_RISK_CANDIDATE.test(text)) return true
  if (/(^|\/)package\.json$/i.test(path) && /"(?:preinstall|install|postinstall|prepare)"\s*:/.test(text)) return true
  if (/(^|\/)\.github\/workflows\/.*\.ya?ml$/i.test(path)
    && /permissions\s*:|(?:contents|packages|actions|id-token|pull-requests)\s*:|pull_request_target\s*:|\buses\s*:|secrets\.|pull_request|head_ref/i.test(text)) return true
  if (/\.(?:[cm]?[jt]sx?)$/i.test(path) && /\b(?:describe|it|test)\.skip\s*\(|\bx(?:it|describe)\s*\(/.test(text)) return true
  if (/\.(?:java|kt|kts)$/i.test(path) && /@Disabled\b/.test(text)) return true
  if (/\.py$/i.test(path) && /pytest\.mark\.skip\b/.test(text)) return true
  return /\.rs$/i.test(path) && /#\[ignore\]/.test(text)
}
