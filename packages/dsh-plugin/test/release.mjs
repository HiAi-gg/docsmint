import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const workflow = readFileSync(process.env.DSH_WORKFLOW_PATH ?? new URL('../ci/dsh-plugin.yml', import.meta.url), 'utf8')
const section = workflow.slice(workflow.indexOf('      - name: Require valid package tag'))
const block = section.split("<<'JS'\n")[1].split('          JS')[0]
const code = block.split('\n').map(line => line.replace(/^          /, '')).filter(line => !line.startsWith('import ')).join('\n')
const gate = new Function('fs', 'execFileSync', 'process', code)
function run(change = {}) {
  const sha = 'a'.repeat(40), head = 'b'.repeat(40), version = change.version ?? '1.0.0-rc.1'
  const env = { GITHUB_REPOSITORY: 'HiAi-gg/docsmint', GITHUB_SHA: sha, GITHUB_REF_NAME: change.tag ?? 'dsh-plugin-v' + version }
  const fs = { readFileSync: () => JSON.stringify({ version }) }
  const exec = (command, args) => {
    if (command === 'git') return sha + '\n'
    const path = args[1]
    if (path.endsWith('/git/ref/heads/main')) return JSON.stringify({ object: { sha: change.staleMain ? head : sha } })
    if (path.endsWith('/environments/dsh-plugin-release')) {
      if (change.missingEnvironment) throw Error('Environment not configured')
      return JSON.stringify({ protection_rules: change.noReviewers ? [] : [{ type: 'required_reviewers', reviewers: [{ reviewer: { login: 'owner' } }] }] })
    }
    if (path.endsWith('/pulls')) return JSON.stringify(change.noPr ? [] : [{ merged_at: 'today', base: { ref: 'main' }, merge_commit_sha: sha, head: { sha: head }, number: 7 }])
    return JSON.stringify({ workflow_runs: path.includes('event=push')
      ? [{ head_branch: 'dsh-plugin-v1', conclusion: null }, { head_branch: 'main', conclusion: change.failedMain ? 'failure' : 'success' }]
      : [{ conclusion: change.failedPr ? 'failure' : 'success', pull_requests: [{ number: 7 }] }] })
  }
  return () => gate(fs, exec, { env })
}
for (const version of ['1.0.0-rc.1', '1.0.0']) test('actual release gate accepts certified ' + version, () => assert.doesNotThrow(run({ version })))
for (const [name, change] of Object.entries({
  leadingZero: { version: '01.0.0' }, numericPrerelease: { version: '1.0.0-01' }, tagMismatch: { tag: 'dsh-plugin-v1.0.1' },
  staleMain: { staleMain: true }, noPr: { noPr: true }, failedMain: { failedMain: true }, failedPr: { failedPr: true },
  missingEnvironment: { missingEnvironment: true }, noReviewers: { noReviewers: true },
})) test('actual release gate refuses ' + name, () => assert.throws(run(change)))
