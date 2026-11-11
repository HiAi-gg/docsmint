/**
 * Plugin-level tests: registration, isolation, credential storage and unload.
 *
 * These cover the concerns that unit tests of the MCP adapter cannot: what the
 * Host half registers, that it releases everything on unload, that secrets stay
 * in the credential store and out of every bridge response, and that the shipped
 * sources import nothing outside the package.
 *
 * Run with `node test/plugin.mjs`.
 */
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply } from '../index.js'

const here = dirname(fileURLToPath(import.meta.url))
const pkg = (name) => readFileSync(join(here, '..', name), 'utf8')

const failures = []
function check(label, condition, detail) {
  if (condition) {
    console.log(`PASS ${label}`)
  } else {
    failures.push(label)
    console.log(`FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`)
  }
}

/* --------------------------------- harness -------------------------------- */

function createHarness({ store, guard = true, beforeSet } = {}) {
  const routes = new Map()
  const tools = new Map()
  const disposers = []
  const credentials = store
    ? {
        async resolve(ref) {
          const value = store.get(ref)
          return value ? { value, source: 'credential store' } : undefined
        },
        async set(ref, value) {
          if (beforeSet) await beforeSet(ref, value)
          store.set(ref, value)
        },
        async unset(ref) {
          store.delete(ref)
        },
      }
    : undefined
  const ctx = {
    get: (name) => name === 'credentials' ? credentials : name === 'connection' && guard ? { requestRejection: () => null } : undefined,
    effect: (callback, label) => {
      const dispose = callback()
      disposers.push({ label, dispose })
      return dispose
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    webServer: {
      getOrigin: () => 'http://127.0.0.1:49869',
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
  }
  apply(ctx)
  return {
    routes,
    tools,
    unload() {
      for (const entry of disposers.reverse()) entry.dispose?.()
      disposers.length = 0
    },
  }
}

async function rpc(routes, method, params) {
  const route = routes.get('/docsmint/rpc')
  const payload = JSON.stringify({ method, params: params ?? null })
  const req = {
    method: 'POST',
    headers: { host: '127.0.0.1:49869' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(payload)
    },
  }
  let status = 0
  let body = ''
  const res = {
    writeHead: (code) => {
      status = code
    },
    end: (chunk) => {
      body += chunk ?? ''
    },
  }
  await route.handler(req, res)
  return { status, text: body, body: body ? JSON.parse(body) : undefined }
}

/* ------------------------------- registration ----------------------------- */

const SECRET = 'dmp_live_test_secret_do_not_leak_0001'
const store = new Map()
const harness = createHarness({ store })

check('registers five tools', [...harness.tools.keys()].sort().join(',') === [
  'docsmint_create_document',
  'docsmint_get_document',
  'docsmint_list_workspace_structure',
  'docsmint_search',
  'docsmint_update_document',
].join(','), [...harness.tools.keys()])

check(
  'registers the bridge and the oauth callback',
  harness.routes.has('/docsmint/rpc') && harness.routes.has('/docsmint/oauth/callback'),
  [...harness.routes.keys()],
)

check(
  'every tool carries a name, description, parameters and output',
  [...harness.tools.values()].every(
    (tool) => tool.name && tool.description && tool.parameters && tool.output?.schema && typeof tool.output.render === 'function',
  ),
)

/* -------------------------------- credentials ----------------------------- */

let state = await rpc(harness.routes, 'state')
check('starts unconfigured in api mode', state.body.mode === 'api' && state.body.configured === false, state.body)
check('reports that it can store credentials', state.body.canStoreCredentials === true, state.body)

let saved = await rpc(harness.routes, 'save', { mode: 'api', apiKey: SECRET, workspace: 'test' })
check('save reports the workspace', saved.body.workspace === 'test' && saved.body.configured === true, saved.body)
check('save persisted the key in the store', store.get('DOCSMINT_API_KEY') === SECRET, [...store.keys()])
check('save response does not echo the key', !saved.text.includes(SECRET))
check('state does not echo the key', !(await rpc(harness.routes, 'state')).text.includes(SECRET))

const listWithKey = await rpc(harness.routes, 'list')
check('list uses the stored key and does not return it', !listWithKey.text.includes(SECRET), listWithKey.body)

const withoutStore = createHarness({})
const denied = await rpc(withoutStore.routes, 'save', { apiKey: SECRET })
check('save fails clearly without a credential store', denied.body.ok === false && denied.body.code === 'no-credential-store', denied.body)
check('state marks the missing store', (await rpc(withoutStore.routes, 'state')).body.canStoreCredentials === false)

const noKey = await rpc(withoutStore.routes, 'list')
check('list without a key explains what to do', noKey.body.ok === false && /API key/i.test(noKey.body.message), noKey.body)

/* ---------------------------------- unload -------------------------------- */

harness.unload()
check('unload removes every route', harness.routes.size === 0, [...harness.routes.keys()])
check('unload unregisters every tool', harness.tools.size === 0, [...harness.tools.keys()])

const restarted = createHarness({ store })
check('re-apply after unload works and keeps the stored credentials', (await rpc(restarted.routes, 'state')).body.configured === true)
check('re-apply registers the tools again', restarted.tools.size === 5, restarted.tools.size)
restarted.unload()

/* ---------------------- profile security regressions --------------------- */
const missingGuard = createHarness({ store: new Map(), guard: false })
check('bridge fails closed without Host authorization service', (await rpc(missingGuard.routes, 'state')).status === 503)
missingGuard.unload()
const originalFetch = globalThis.fetch
const seenAuth = []
let refreshCalls = 0
let revokedRefresh = false
let exchangeCalls = 0
let releaseExchange
let exchangeGate = Promise.resolve()
let releaseRefresh
let refreshGate = Promise.resolve()
const tools = [{ name: 'find_documents', inputSchema: { type: 'object', properties: { mode: { const: 'list' }, limit: {}, page: {}, folderId: {}, workspaceId: {}, categoryId: {}, sortBy: {}, sortOrder: {}, q: {}, rootOnly: {}, tag: {}, tagIds: {}, tagMatch: {}, updatedFrom: {}, updatedTo: {} }, required: ['mode'] } }]
const calls = []
let scopedFixture
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input))
  if (url.pathname.includes('oauth-protected-resource')) return Response.json({ resource: 'https://docsmint.com/mcp', authorization_servers: ['https://docsmint.com'] })
  if (url.pathname.includes('oauth-authorization-server') || url.pathname.includes('openid-configuration')) return Response.json({ issuer: 'https://docsmint.com', authorization_endpoint: 'https://docsmint.com/authorize', token_endpoint: 'https://docsmint.com/token', registration_endpoint: 'https://docsmint.com/register', code_challenge_methods_supported: ['S256'], scopes_supported: ['mcp:read'] })
  if (url.pathname === '/register') return Response.json({ client_id: 'synthetic-client' })
  if (url.pathname === '/token') {
    const body = new URLSearchParams(init.body)
    if (body.get('grant_type') === 'refresh_token') { refreshCalls++; await refreshGate }
    else { exchangeCalls++; await exchangeGate }
    if (revokedRefresh) {
      return Response.json({ error: 'invalid_grant', error_description: 'Invalid or expired refresh token' }, { status: 400 })
    }
    return Response.json({ access_token: 'renewed-access', refresh_token: 'rotated-refresh', expires_in: 3600, token_type: 'Bearer' })
  }
  const authorization = new Headers(init.headers).get('authorization')
  seenAuth.push(authorization)
  if (url.pathname === '/mcp') {
    const body = JSON.parse(init.body); calls.push(body)
    return Response.json({ jsonrpc: '2.0', id: body.id, result: body.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } } : body.method === 'tools/list' ? { tools } : { structuredContent: scopedFixture ?? { operation: 'list', result: { items: [], total: 0 } }, content: [] } })
  }
  calls.push({ rest: url })
  return Response.json({ items: [], total: 0 })
}
const makeProfile = (key) => createHarness({ store: new Map([['DOCSMINT_API_KEY', key], ['DOCSMINT_ENDPOINT', 'http://127.0.0.1:59999'], ['DOCSMINT_MODE', 'mcp']]) })
const one = makeProfile('profile-one-key'), two = makeProfile('profile-two-key')
await rpc(one.routes, 'list'); seenAuth.length = 0
await rpc(two.routes, 'list')
check('same endpoint in another context uses only its own key', seenAuth.length > 0 && seenAuth.every(value => value === 'Bearer profile-two-key'), seenAuth)
const filterInput = { categoryId: 'category-a', sortBy: 'title', sortOrder: 'asc', q: 'literal query', rootOnly: false, tagIds: ['tag-a', 'tag-b'], tagMatch: 'any', updatedFrom: '2026-01-01T00:00:00Z', updatedTo: '2026-02-01T00:00:00Z' }
await rpc(two.routes, 'list', filterInput)
const mapped = calls.filter(call => call.method === 'tools/call').at(-1).params.arguments
check('MCP bridge forwards filters including false and tag arrays', Object.entries(filterInput).every(([key, value]) => JSON.stringify(mapped[key]) === JSON.stringify(value)), mapped)
await rpc(two.routes, 'save', { mode: 'api' })
await rpc(two.routes, 'list', filterInput)
const rest = calls.filter(call => call.rest).at(-1).rest
check('REST bridge forwards filters with CSV tags and false', rest.searchParams.get('tagIds') === 'tag-a,tag-b' && rest.searchParams.get('rootOnly') === 'false' && rest.searchParams.get('categoryId') === 'category-a' && rest.searchParams.get('sortBy') === 'title', String(rest))
tools.push({ name: 'list_workspace_structure', inputSchema: { oneOf: ['folders', 'categories', 'workspaces'].map(kind => ({
  type: 'object', properties: { kind: { const: kind }, workspaceId: {} }, required: ['kind'],
})) } })
const structureProfile = makeProfile('profile-structure-key')
const structure = structureProfile.tools.get('docsmint_list_workspace_structure')
for (const kind of ['folders', 'categories']) {
  scopedFixture = { operation: kind, result: [{ id: 'item-' + kind, name: 'Visible ' + kind, categoryId: 'category-a' }] }
  const value = structure ? await structure.execute({ kind, workspaceId: 'workspace-a' }) : undefined
  const last = calls.filter(call => call.method === 'tools/call').at(-1)?.params
  check('agent lists ' + kind + ' with real IDs and workspace routing', value?.items[0]?.id === 'item-' + kind &&
    last?.name === 'list_workspace_structure' && last.arguments.kind === kind && last.arguments.workspaceId === 'workspace-a')
}
scopedFixture = undefined
structureProfile.unload()
const cachedCalls = calls.filter(call => call.method === 'initialize').length
scopedFixture = { operation: 'list', scopedResults: ['alpha', 'beta'].map((name) => ({ workspace: { id: name, slug: name + '-slug', name }, categoryId: null, data: { operation: 'list', result: { items: [{ id: 'same-doc-id', title: name, url: 'http://127.0.0.1:59999/w/' + name + '-slug/documents/same-doc-id' }], total: 20 } } })) }
const fanout = await rpc(one.routes, 'list')
check('bridge preserves workspace identity in scoped document rows', fanout.body.items.length === 2 && fanout.body.items[0].workspaceId === 'alpha' && fanout.body.items[1].workspaceSlug === 'beta-slug' && fanout.body.items[1].url.includes('/beta-slug/'), fanout.body)
check('bridge preserves original scope pages without inventing a global total', fanout.body.scopedResults.length === 2 && fanout.body.pagination === 'per-scope' && fanout.body.totalIsGlobal === false && fanout.body.total === 2, fanout.body)
scopedFixture = undefined
one.unload()
const three = makeProfile('profile-three-key')
await rpc(three.routes, 'list')
check('unload releases cached MCP discovery for the next context', calls.filter(call => call.method === 'initialize').length === cachedCalls + 1)
const token = { access_token: 'expired-access', refresh_token: 'refresh-once', expires_at: 1, client_id: 'synthetic-client', token_endpoint: 'https://docsmint.com/token', resource: 'https://docsmint.com/mcp' }
const oauthStore = new Map([['DOCSMINT_OAUTH', JSON.stringify(token)], ['DOCSMINT_MODE', 'mcp']])
const oauth = createHarness({ store: oauthStore })
refreshGate = new Promise(resolve => { releaseRefresh = resolve })
const first = rpc(oauth.routes, 'list'), second = rpc(oauth.routes, 'list')
await new Promise(resolve => setTimeout(resolve, 20)); releaseRefresh()
await Promise.all([first, second])
check('concurrent expired-token calls rotate refresh only once per context', refreshCalls === 1, refreshCalls)

revokedRefresh = true
const revokedStore = new Map([['DOCSMINT_OAUTH', JSON.stringify(token)], ['DOCSMINT_MODE', 'mcp']])
const revoked = createHarness({ store: revokedStore })
const revokedCall = await rpc(revoked.routes, 'list')
check(
  'a revoked refresh token clears the record and asks for a fresh consent',
  revokedCall.body?.code === 'mcp-needs-oauth' && revokedStore.has('DOCSMINT_OAUTH') === false,
  { body: revokedCall.body, stillStored: revokedStore.has('DOCSMINT_OAUTH') },
)
revoked.unload()
const replacedStore = new Map([['DOCSMINT_OAUTH', JSON.stringify(token)], ['DOCSMINT_MODE', 'mcp']])
const replaced = createHarness({ store: replacedStore })
let finishRefusedRefresh
refreshGate = new Promise(resolve => { finishRefusedRefresh = resolve })
const replacedCall = rpc(replaced.routes, 'list')
await new Promise(resolve => setTimeout(resolve, 20))
const replacement = JSON.stringify({ ...token, access_token: 'new-test-access', refresh_token: 'new-test-refresh', expires_at: Date.now() + 3600000 })
replacedStore.set('DOCSMINT_OAUTH', replacement)
finishRefusedRefresh()
const replacedResult = await replacedCall
check('a stale refresh refusal preserves a newer OAuth record', replacedStore.get('DOCSMINT_OAUTH') === replacement && replacedResult.body?.code === 'connection-changed')
replaced.unload()
revokedRefresh = false
const pendingRefreshStore = new Map([['DOCSMINT_OAUTH', JSON.stringify(token)], ['DOCSMINT_MODE', 'mcp']])
const pendingRefresh = createHarness({ store: pendingRefreshStore })
refreshGate = new Promise(resolve => { releaseRefresh = resolve })
const lateRefresh = rpc(pendingRefresh.routes, 'list')
await new Promise(resolve => setTimeout(resolve, 20))
await rpc(pendingRefresh.routes, 'mcpDisconnect')
releaseRefresh(); await lateRefresh
check('disconnect fences an in-flight refresh without restoring the token', !pendingRefreshStore.has('DOCSMINT_OAUTH'))
pendingRefresh.unload()
const delayedStore = new Map([['DOCSMINT_OAUTH', JSON.stringify(token)], ['DOCSMINT_MODE', 'mcp']])
let releaseStoreSet
let enteredStoreSet
const storeSetStarted = new Promise(resolve => { enteredStoreSet = resolve })
const storeSetGate = new Promise(resolve => { releaseStoreSet = resolve })
let blockStoreOnce = true
const delayed = createHarness({ store: delayedStore, beforeSet: async (ref) => {
  if (ref === 'DOCSMINT_OAUTH' && blockStoreOnce) { blockStoreOnce = false; enteredStoreSet(); await storeSetGate }
} })
refreshGate = Promise.resolve()
const writingRefresh = rpc(delayed.routes, 'list')
await storeSetStarted
const disconnectDuringSet = rpc(delayed.routes, 'mcpDisconnect')
await new Promise(resolve => setTimeout(resolve, 10))
releaseStoreSet()
await Promise.all([writingRefresh, disconnectDuringSet])
check('disconnect is ordered after an in-flight asynchronous credential set', !delayedStore.has('DOCSMINT_OAUTH'))
delayed.unload()
const ownerStore = new Map(), owner = createHarness({ store: ownerStore }), foreignStore = new Map(), foreign = createHarness({ store: foreignStore })
const begun = await rpc(owner.routes, 'mcpConnect')
const stateValue = begun.body.authorizeUrl ? new URL(begun.body.authorizeUrl).searchParams.get('state') : ''
async function callback(profile, state) {
  let status; let body = ''
  await profile.routes.get('/docsmint/oauth/callback').handler({ method: 'GET', url: '/docsmint/oauth/callback?state=' + state + '&code=synthetic-code' }, { writeHead(code) { status = code }, end(value) { body += value } })
  return { status, body }
}
const refused = await callback(foreign, stateValue)
check('foreign context cannot consume another profile OAuth state', stateValue && refused.status === 400 && !foreignStore.has('DOCSMINT_OAUTH') && exchangeCalls === 0, begun.body)
exchangeGate = new Promise(resolve => { releaseExchange = resolve })
const activeCallback = callback(owner, stateValue)
await new Promise(resolve => setTimeout(resolve, 20))
const replay = await callback(owner, stateValue)
owner.unload(); releaseExchange(); await activeCallback
check('OAuth state is consumed before exchange and rejects concurrent replay', replay.status === 400 && exchangeCalls === 1, replay.status)
check('unload fences an in-flight OAuth credential write', !ownerStore.has('DOCSMINT_OAUTH'))
for (const profile of [two, three, oauth, foreign]) profile.unload()
/* A credential store can yield between individual writes. Connection readers
 * and whole save batches must share one queue, never observe a mixed tuple. */
for (const concurrentSave of [false, true]) {
  const saveStore = new Map([['DOCSMINT_API_KEY', 'old-key'], ['DOCSMINT_ENDPOINT', 'http://127.0.0.1:59000/api'], ['DOCSMINT_WORKSPACE', 'old-space'], ['DOCSMINT_MODE', 'api']])
  let entered, release
  const started = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  let blockOnce = true
  const profile = createHarness({ store: saveStore, beforeSet: async ref => {
    if (ref === 'DOCSMINT_API_KEY' && blockOnce) { blockOnce = false; entered(); await gate }
  } })
  const sent = []
  globalThis.fetch = async (input, init) => { sent.push({ url: String(input), key: new Headers(init.headers).get('authorization'), workspace: new Headers(init.headers).get('x-docsmint-workspace') }); return Response.json({ items: [], total: 0 }) }
  const saveA = rpc(profile.routes, 'save', { deployment: 'self-hosted', baseUrl: 'http://127.0.0.1:59001', apiKey: 'key-a', workspace: 'space-a', mode: 'api' })
  await started
  const saveB = concurrentSave ? rpc(profile.routes, 'save', { deployment: 'self-hosted', baseUrl: 'http://127.0.0.1:59002', apiKey: 'key-b', workspace: 'space-b', mode: 'api' }) : Promise.resolve()
  const readDuringSave = rpc(profile.routes, 'list')
  await new Promise(resolve => setTimeout(resolve, 10))
  check(`connection reader waits for an incomplete save batch (${concurrentSave ? 'two saves' : 'one save'})`, sent.length === 0)
  release()
  await Promise.all([saveA, saveB, readDuringSave])
  const letter = concurrentSave ? 'b' : 'a', port = concurrentSave ? 59002 : 59001
  check(`connection saves and readers preserve one complete credential tuple (${concurrentSave ? 'two saves' : 'one save'})`, sent.length === 1 && sent[0].url.startsWith(`http://127.0.0.1:${port}/`) && sent[0].key === `Bearer key-${letter}` && sent[0].workspace === `space-${letter}`, sent)
  profile.unload()
}
const failureStore = new Map([['DOCSMINT_API_KEY', 'old-key'], ['DOCSMINT_ENDPOINT', 'http://127.0.0.1:59000/api'], ['DOCSMINT_WORKSPACE', 'old-space'], ['DOCSMINT_MODE', 'api']])
let failEndpointOnce = true
const failedBatch = createHarness({ store: failureStore, beforeSet: async ref => { if (ref === 'DOCSMINT_ENDPOINT' && failEndpointOnce) { failEndpointOnce = false; throw new Error('synthetic store failure') } } })
const failedSave = await rpc(failedBatch.routes, 'save', { deployment: 'self-hosted', baseUrl: 'http://127.0.0.1:59003', apiKey: 'partial-key', workspace: 'partial-space' })
check('partial save failure restores the prior credential tuple', !failedSave.body.ok && failureStore.get('DOCSMINT_API_KEY') === 'old-key' && failureStore.get('DOCSMINT_WORKSPACE') === 'old-space' && failureStore.get('DOCSMINT_ENDPOINT') === 'http://127.0.0.1:59000/api')
let failedBatchRequests = 0
globalThis.fetch = async () => { failedBatchRequests++; return Response.json({ items: [] }) }
await rpc(failedBatch.routes, 'list')
check('partial store failure blocks outbound credentials until a successful save', failedBatchRequests === 0)
failedBatch.unload()
const restProfile = createHarness({ store: new Map([['DOCSMINT_API_KEY', 'private-rest-key'], ['DOCSMINT_ENDPOINT', 'http://127.0.0.1:59998'], ['DOCSMINT_MODE', 'api']]) })
let cancelled = false
globalThis.fetch = async (_input, init) => {
  check('REST explicitly rejects credential-bearing redirects', init.redirect === 'error')
  return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1_048_577)) }, cancel() { cancelled = true } }))
}
const oversized = await rpc(restProfile.routes, 'list')
check('REST bounds streaming responses and cancels oversized bodies', oversized.body.code === 'response-too-large' && cancelled)
globalThis.fetch = async () => Response.json({ error: 'private-rest-key' }, { status: 500 })
const reflectedRest = await rpc(restProfile.routes, 'list')
check('REST never exposes reflected bearer credentials', reflectedRest.body.ok === false && !reflectedRest.text.includes('private-rest-key'))
globalThis.fetch = async () => { throw new Error('provider reflected private-rest-key') }
check('REST transport errors do not expose provider exceptions', !(await rpc(restProfile.routes, 'list')).text.includes('private-rest-key'))
let restRequest
let returnedDoc = { id: 'selected-doc', title: 'Selected', content: '', workspaceSlug: 'second-space', url: 'http://127.0.0.1:59998/w/second-space/documents/selected-doc' }
globalThis.fetch = async (input, init) => { restRequest = { url: new URL(String(input)), init }; return Response.json(returnedDoc) }
const createdSelected = await rpc(restProfile.routes, 'create', { title: 'Selected', workspaceId: 'workspace-two', categoryId: 'category-two' })
check('REST create targets the selected workspace and category', new Headers(restRequest.init.headers).get('x-docsmint-workspace') === 'workspace-two' && JSON.parse(restRequest.init.body).categoryId === 'category-two')
check('document links preserve an authoritative same-origin URL', createdSelected.body.document.url === returnedDoc.url, createdSelected.body)
await rpc(restProfile.routes, 'search', { query: 'needle', workspaceId: 'workspace-two', categoryId: 'category-two' })
check('REST search targets the selected workspace and category', new Headers(restRequest.init.headers).get('x-docsmint-workspace') === 'workspace-two' && restRequest.url.searchParams.get('category') === 'category-two')
returnedDoc = { ...returnedDoc, url: 'https://foreign.invalid/private' }
const foreignLink = await rpc(restProfile.routes, 'get', { id: 'selected-doc' })
check('foreign document URLs are rejected and OSS uses its own route', foreignLink.body.document.url === 'http://127.0.0.1:59998/docs/selected-doc', foreignLink.body)
restProfile.unload()
globalThis.fetch = originalFetch
let redirectedCalls = 0
let redirectStatus = 307
const redirectServer = createServer((req, res) => {
  if (req.url === '/sink') { redirectedCalls++; res.end('{}'); return }
  res.writeHead(redirectStatus, { location: '/sink' }); res.end()
})
await new Promise(resolve => redirectServer.listen(0, '127.0.0.1', resolve))
try {
  const port = redirectServer.address().port
  const redirectProfile = createHarness({ store: new Map([['DOCSMINT_API_KEY', 'private-redirect-key'], ['DOCSMINT_ENDPOINT', `http://127.0.0.1:${port}`], ['DOCSMINT_MODE', 'api']]) })
  for (const status of [307, 308]) {
    redirectStatus = status
    const result = await rpc(redirectProfile.routes, 'list')
    check(`REST ${status} redirects never forward credentials to the target`, result.body.ok === false && redirectedCalls === 0)
  }
  redirectProfile.unload()
} finally { await new Promise(resolve => redirectServer.close(resolve)) }

/* -------------------------------- sources --------------------------------- */

const index = pkg('index.js')
const client = pkg('client.js')
const mcp = pkg('mcp.js')

check('host half imports only its own module', /from '\.\/mcp\.js'/.test(index) && !/from '@deepseek-ai\//.test(index) && !/from 'node:/.test(index))
check('adapter module has no unresolved imports', !/^import /m.test(mcp), mcp.match(/^import .*/m)?.[0])
check('no filesystem or process control in the plugin', !/\b(?:node:fs|node:child_process|child_process|require\('fs'\))\b/.test(index + mcp + client))
check('client half never sends an authorization header', !/authorization/i.test(client))
const fetchTargets = [...client.matchAll(/fetch\(\s*([A-Za-z_$][\w$]*|'[^']*')/g)].map((match) => match[1])
check(
  'client half talks only to its own bridge route',
  fetchTargets.length > 0 && fetchTargets.every((target) => target === 'RPC_PATH'),
  fetchTargets,
)
check('client half loads one module', (client.match(/__ModuleLoader__\.load\(/g) ?? []).length === 1)
check(
  'client half registers the sidebar entry and the panel',
  /id: 'docsmint'/.test(client) && /key: 'docsmint'/.test(client) && /name: 'sidebar\.panellist'/.test(client),
)
check('patch names the package and the row', /name: '@hiai-gg\/dsh-docsmint'/.test(pkg('cordis.patch.yml')) && /id: docsmint/.test(pkg('cordis.patch.yml')))
check('manifest declares the bundle patch it ships', JSON.parse(pkg('package.json')).dsh.bundle.patch === './cordis.patch.yml')

if (failures.length > 0) {
  console.log(`\n${failures.length} failing check(s): ${failures.join('; ')}`)
  process.exitCode = 1
} else {
  console.log('\nall checks passed')
}
