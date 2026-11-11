/**
 * Adapter tests for the DocsMint MCP transport and the OAuth flow.
 *
 * Boots a local fake DocsMint deployment that mirrors the real server's shapes —
 * discriminated-union tools, the `{ operation, result }` envelope, JSON and SSE
 * responses — then drives `mcp.js` through it. Run with `node test/mcp.mjs`.
 */
import { createServer } from 'node:http'
import { createMcpSession, discoverAuthorization, exchangeAuthorizationCode, pkcePair, refreshOAuthToken, registerOAuthClient } from '../mcp.js'

const failures = []
function check(label, condition, detail) {
  if (condition) {
    console.log(`PASS ${label}`)
  } else {
    failures.push(label)
    console.log(`FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`)
  }
}

/* ------------------------------ fake DocsMint ----------------------------- */

let scopedOverride
const calls = []
const asState = { challenge: undefined, clientId: undefined, tokenCalls: [] }

function json(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function sse(res, value) {
  const body = `event: message\ndata: ${JSON.stringify(value)}\n\n`
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
  res.end(body)
}

/** The tool inventory, shaped like the real DocsMint 2.x server. */
const TOOLS = [
  {
    name: 'find_documents',
    inputSchema: {
      type: 'object',
      oneOf: [
        {
          type: 'object',
          properties: {
            mode: { type: 'string', const: 'list' },
            folderId: { type: 'string' },
            workspaceId: { type: 'string' },
            limit: { type: 'integer' },
            page: { type: 'integer' },
          },
          required: ['mode'],
        },
        {
          type: 'object',
          properties: {
            mode: { type: 'string', const: 'search' },
            query: { type: 'string' },
            limit: { type: 'integer' },
            workspaceId: { type: 'string' },
          },
          required: ['mode', 'query'],
        },
      ],
    },
  },
  {
    name: 'read_document',
    inputSchema: {
      type: 'object',
      oneOf: [
        {
          type: 'object',
          properties: { view: { type: 'string', const: 'detail' }, id: { type: 'string' } },
          required: ['view', 'id'],
        },
        {
          type: 'object',
          properties: { view: { type: 'string', const: 'markdown' }, id: { type: 'string' } },
          required: ['view', 'id'],
        },
      ],
    },
  },
  {
    name: 'save_document',
    inputSchema: {
      type: 'object',
      oneOf: [
        {
          type: 'object',
          properties: {
            action: { type: 'string', const: 'create' },
            title: { type: 'string' },
            content: { type: 'string' },
            folderId: { type: 'string' },
          },
          required: ['action'],
        },
        {
          type: 'object',
          properties: {
            action: { type: 'string', const: 'update' },
            id: { type: 'string' },
            title: { type: 'string' },
            content: { type: 'string' },
          },
          required: ['action', 'id'],
        },
      ],
    },
  },
  {
    name: 'delete_document',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'list_workspace_structure',
    inputSchema: {
      type: 'object',
      oneOf: [
        { type: 'object', properties: { kind: { type: 'string', const: 'workspaces' } }, required: ['kind'] },
        { type: 'object', properties: { kind: { type: 'string', const: 'folders' } }, required: ['kind'] },
        { type: 'object', properties: { kind: { type: 'string', const: 'categories' } }, required: ['kind'] },
      ],
    },
  },
  {
    name: 'save_folder',
    inputSchema: {
      type: 'object',
      oneOf: [
        {
          type: 'object',
          properties: {
            action: { type: 'string', const: 'create' },
            name: { type: 'string' },
            categoryId: { type: 'string' },
            workspaceId: { type: 'string' },
          },
          required: ['action', 'name'],
        },
      ],
    },
  },
  {
    name: 'save_category',
    inputSchema: {
      type: 'object',
      oneOf: [
        {
          type: 'object',
          properties: { action: { type: 'string', const: 'create' }, name: { type: 'string' }, workspaceId: { type: 'string' } },
          required: ['action', 'name'],
        },
      ],
    },
  },
]

const DOCS = [
  {
    id: '11111111-1111-1111-1111-111111111111',
    title: 'Alpha',
    workspaceId: 'workspace-a',
    workspaceSlug: 'workspace-a-slug',
    url: 'https://docsmint.com/w/workspace-a-slug/documents/11111111-1111-1111-1111-111111111111',
    content: '# Alpha',
    folderId: '44444444-4444-4444-4444-444444444444',
    folderName: 'Folder A',
    categoryId: '55555555-5555-5555-5555-555555555555',
    categoryName: 'Cat',
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-02T10:00:00.000Z',
    tags: [],
    visibility: 'private',
  },
]

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  let body
  try {
    body = raw ? JSON.parse(raw) : undefined
  } catch {
    body = undefined
  }
  const origin = `http://127.0.0.1:${server.address().port}`

  if (url.pathname === '/.well-known/oauth-protected-resource/mcp') {
    json(res, 200, {
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      scopes_supported: ['mcp:read', 'mcp:edit', 'mcp:write'],
    })
    return
  }
  if (url.pathname === '/.well-known/oauth-authorization-server') {
    json(res, 200, {
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp:read', 'mcp:edit', 'mcp:write'],
    })
    return
  }
  if (url.pathname === '/oauth/register') {
    asState.clientId = 'client-test'
    json(res, 200, { client_id: asState.clientId, redirect_uris: body?.redirect_uris ?? [] })
    return
  }
  if (url.pathname === '/oauth/token') {
    const form = new URLSearchParams(raw)
    const grant = form.get('grant_type')
    asState.tokenCalls.push({ grant, verifier: form.get('code_verifier'), redirectUri: form.get('redirect_uri') })
    if (form.get('refresh_token') === 'revoked-refresh' || form.get('code') === 'expired-code') {
      const description = grant === 'refresh_token'
        ? 'Invalid or expired refresh token'
        : 'Invalid or expired authorization code'
      json(res, 400, { error: 'invalid_grant', error_description: description })
      return
    }
    if (grant === 'authorization_code' && asState.challenge) {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(form.get('code_verifier') ?? ''))
      if (Buffer.from(new Uint8Array(digest)).toString('base64url') !== asState.challenge) {
        json(res, 400, { error: 'invalid_grant', error_description: 'PKCE mismatch' })
        return
      }
    }
    json(res, 200, {
      access_token: grant === 'refresh_token' ? 'access-refreshed' : 'access-1',
      refresh_token: 'refresh-1',
      token_type: 'Bearer',
      expires_in: 3600,
    })
    return
  }

  if (url.pathname === '/mcp' && req.method === 'POST') {
    const auth = req.headers.authorization ?? ''
    if (!auth.startsWith('Bearer ')) {
      json(res, 401, { error: 'unauthorized' })
      return
    }
    calls.push(body)
    const reply = (result) => {
      const value = { jsonrpc: '2.0', id: body.id, result }
      // Alternate transports so both decoders are exercised.
      if (body.method === 'tools/call' && body.params?.name === 'find_documents' && body.params?.arguments?.mode === 'search') sse(res, value)
      else json(res, 200, value)
    }

    if (body.method === 'initialize') {
      reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'docsmint-fake', version: '2.0.4' } })
      return
    }
    if (body.method === 'tools/list') {
      reply({ tools: TOOLS })
      return
    }
    if (body.method === 'tools/call') {
      const { name, arguments: args } = body.params ?? {}
      if (scopedOverride) { reply(scopedOverride); return }
      if (name === 'find_documents') {
        reply({
          structuredContent: {
            operation: args.mode,
            result: { items: DOCS, total: 1, page: 1, limit: args.limit ?? 20 },
          },
        })
        return
      }
      if (name === 'read_document') {
        reply({
          structuredContent:
            args.view === 'markdown'
              ? { operation: 'markdown', result: { markdown: '# Alpha' } }
              : { operation: 'detail', result: DOCS[0] },
        })
        return
      }
      if (name === 'save_document') {
        reply({
          structuredContent: {
            operation: args.action,
            result: { ...DOCS[0], id: args.id ?? '99999999-9999-9999-9999-999999999999', title: args.title ?? DOCS[0].title, content: args.content ?? '' },
          },
        })
        return
      }
      if (name === 'list_workspace_structure') {
        const lists = {
          workspaces: [{ id: 'w-1', name: 'Test', slug: 'test', entireWorkspace: true }],
          folders: [{ id: '44444444-4444-4444-4444-444444444444', name: 'Folder A', categoryId: '55555555-5555-5555-5555-555555555555', parentId: null }],
          categories: [{ id: '55555555-5555-5555-5555-555555555555', name: 'Cat' }],
        }
        reply({ structuredContent: { operation: args.kind, result: lists[args.kind] ?? [] } })
        return
      }
      if (name === 'save_folder' || name === 'save_category') {
        reply({ structuredContent: { operation: 'create', result: { id: 'new-entity', name: args.name } } })
        return
      }
      reply({ isError: true, content: [{ type: 'text', text: `unknown tool ${name}` }] })
      return
    }
    json(res, 200, { jsonrpc: '2.0', id: body.id, result: {} })
    return
  }

  json(res, 404, { error: `no route ${req.method} ${url.pathname}` })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
const endpoint = `${origin}/mcp`

/* ---------------------------------- tests --------------------------------- */

const session = createMcpSession({ endpoint, authorize: async () => ({ headers: { authorization: 'Bearer test-token' } }) })

let result = await session.invoke('search', { query: 'alpha', limit: 5 })
check('search returns rows from the SSE envelope', result.ok === true && result.data.items[0].title === 'Alpha', result)
check('search maps limit onto the search branch', calls.at(-1)?.params?.arguments?.mode === 'search' && calls.at(-1)?.params?.arguments?.query === 'alpha', calls.at(-1)?.params?.arguments)

result = await session.invoke('list', { folderId: '44444444-4444-4444-4444-444444444444', limit: 3 })
check('list returns rows from the JSON envelope', result.ok === true && result.data.items.length === 1, result)
check(
  'list selects mode=list and forwards folderId',
  calls.at(-1)?.params?.arguments?.mode === 'list' && calls.at(-1)?.params?.arguments?.folderId === '44444444-4444-4444-4444-444444444444',
  calls.at(-1)?.params?.arguments,
)

result = await session.invoke('get', { id: DOCS[0].id })
check('get selects view=detail', calls.at(-1)?.params?.arguments?.view === 'detail', calls.at(-1)?.params?.arguments)
check('get returns the document', result.ok === true && result.data.id === DOCS[0].id && result.data.title === 'Alpha', result)
check('get preserves server workspace and deep-link metadata', result.data.workspaceId === DOCS[0].workspaceId && result.data.workspaceSlug === DOCS[0].workspaceSlug && result.data.url === DOCS[0].url, result)


result = await session.invoke('create', { title: 'New', content: '# New' })
check('create selects action=create', calls.at(-1)?.params?.arguments?.action === 'create', calls.at(-1)?.params?.arguments)
check('create returns the new id', result.ok === true && result.data.id === '99999999-9999-9999-9999-999999999999', result)

result = await session.invoke('update', { id: DOCS[0].id, title: 'Alpha 2', content: '# Alpha 2' })
check('update selects action=update', calls.at(-1)?.params?.arguments?.action === 'update', calls.at(-1)?.params?.arguments)
check('update returns the stored title', result.ok === true && result.data.title === 'Alpha 2', result)

result = await session.invoke('workspaces', {})
check('workspaces lists the slug', result.ok === true && result.data.items[0].slug === 'test', result)

result = await session.invoke('folders', {})
check('folders carries categoryId', result.ok === true && result.data.items[0].categoryId === '55555555-5555-5555-5555-555555555555', result)

result = await session.invoke('create-folder', { name: 'New folder', categoryId: '55555555-5555-5555-5555-555555555555' })
check('create-folder selects action=create', calls.at(-1)?.params?.arguments?.action === 'create', calls.at(-1)?.params?.arguments)
check('create-folder returns the entity', result.ok === true && result.data.name === 'New folder', result)

result = await session.invoke('create-category', { name: 'New cat' })
check('create-category returns the entity', result.ok === true && result.data.name === 'New cat', result)

/* Cloud fanout carries independent pages. Preserve that envelope rather than
 * presenting an invented globally paginated or summed result. */
const scopeA = { workspace: { id: 'scope-a', slug: 'alpha-space', name: 'Alpha workspace' }, categoryId: null,
  data: { operation: 'list', result: { items: [{ id: 'same-id', title: 'Alpha scoped', url: 'https://docsmint.com/w/alpha-space/documents/same-id' }], total: 7, page: 2, limit: 1 } } }
const scopeB = { workspace: { id: 'scope-b', slug: 'beta-space', name: 'Beta workspace' }, categoryId: 'category-b',
  data: { operation: 'list', result: { items: [{ id: 'same-id', title: 'Beta scoped', url: 'https://docsmint.com/w/beta-space/documents/same-id' }], total: 9, page: 2, limit: 1 } } }
const scopedList = { operation: 'list', scopedResults: [scopeA, scopeB] }
scopedOverride = { structuredContent: scopedList, content: [{ type: 'text', text: JSON.stringify({ operation: 'list', result: { items: [{ id: 'wrong-text-copy', title: 'Wrong' }] } }) }] }
result = await session.invoke('list', { limit: 1, page: 2 })
check('multi-workspace structuredContent wins over its text copy', result.ok && result.data.items.length === 2 && !result.data.items.some(row => row.id === 'wrong-text-copy'), result)
check('scoped rows preserve same-id documents with distinct workspace identity', result.data.items[0].id === result.data.items[1].id && result.data.items[0].workspaceId === 'scope-a' && result.data.items[1].workspaceId === 'scope-b' && result.data.items[0].workspaceSlug === 'alpha-space' && result.data.items[1].workspaceSlug === 'beta-space', result)
check('scoped rows retain each document URL', result.data.items[0].url === scopeA.data.result.items[0].url && result.data.items[1].url === scopeB.data.result.items[0].url, result)
check('independent scoped pages and totals remain available without a global-total claim', result.data.scopedResults[0].data.result.total === 7 && result.data.scopedResults[1].data.result.page === 2 && result.data.total === 2 && result.data.totalIsGlobal === false && result.data.pagination === 'per-scope', result)
result = await session.invoke('search', { query: 'scoped' })
check('search also preserves scoped rows and source envelopes', result.ok && result.data.items.length === 2 && result.data.scopedResults.length === 2 && result.data.items[1].workspaceId === 'scope-b', result)
scopedOverride = { structuredContent: { operation: 'list', scopedResults: [{ ...scopeA, data: { operation: 'list', result: { items: [], total: 0 } } }] }, content: [{ type: 'text', text: 'not a document row' }] }
result = await session.invoke('list', {})
check('empty scoped pages remain empty without degraded text fallback', result.ok && result.data.items.length === 0 && !result.data.degraded && result.data.scopedResults.length === 1, result)
const scopedDoc = { id: 'scope-document', title: 'Scoped detail', content: '# Scoped detail', url: 'https://docsmint.com/w/alpha-space/documents/scope-document' }
scopedOverride = { structuredContent: { operation: 'detail', scopedResults: [{ ...scopeA, data: { operation: 'detail', result: scopedDoc } }] } }
result = await session.invoke('get', { id: scopedDoc.id })
check('one scoped detail resolves its document and workspace metadata', result.ok && result.data.id === scopedDoc.id && result.data.content === scopedDoc.content && result.data.workspaceId === 'scope-a' && result.data.workspaceSlug === 'alpha-space' && result.data.url === scopedDoc.url && result.data.scopedResults.length === 1, result)
scopedOverride.structuredContent.scopedResults.push({ ...scopeB, data: { operation: 'detail', result: { id: 'different-document', title: 'Other detail', content: 'Other' } } })
result = await session.invoke('get', { id: scopedDoc.id })
check('ambiguous scoped detail fails instead of choosing the first document', !result.ok && result.code === 'mcp-scoped-document' && result.data === undefined, result)
scopedOverride.structuredContent.scopedResults[1] = { ...scopeB, data: { error: { code: 'SCOPE_FAILED' } } }
result = await session.invoke('get', { id: scopedDoc.id })
check('a failed detail scope is not silently hidden by a successful scope', !result.ok && result.code === 'mcp-scoped-document', result)
scopedOverride = undefined

/* ---------------------------------- OAuth --------------------------------- */

const discovery = await discoverAuthorization(origin)
check('discovery reads the protected resource', discovery.ok === true && discovery.resource === endpoint, discovery)
check('discovery exposes scopes', Array.isArray(discovery.scopes) && discovery.scopes.includes('mcp:read'), discovery.scopes)

const registration = await registerOAuthClient(discovery.metadata, { redirectUri: 'http://127.0.0.1:49869/docsmint/oauth/callback', scope: 'mcp:read' })
check('registration returns a client id', registration.ok === true && registration.clientId === 'client-test', registration)

const { verifier, challenge } = await pkcePair()
asState.challenge = challenge
check('pkce challenge is base64url sha256', /^[A-Za-z0-9_-]{43}$/.test(challenge), challenge)

const exchanged = await exchangeAuthorizationCode(
  discovery.metadata,
  { clientId: registration.clientId, code: 'code-1', verifier, redirectUri: 'http://127.0.0.1:49869/docsmint/oauth/callback', resource: discovery.resource },
)
check('code exchange succeeds with the pkce verifier', exchanged.ok === true && exchanged.tokens.accessToken === 'access-1', exchanged)
check(
  'exchange forwards the redirect uri',
  asState.tokenCalls.at(-1)?.redirectUri === 'http://127.0.0.1:49869/docsmint/oauth/callback',
  asState.tokenCalls.at(-1),
)

const refreshed = await refreshOAuthToken({ token_endpoint: discovery.metadata.token_endpoint }, { clientId: registration.clientId, refreshToken: 'refresh-1' })
check('refresh returns a new access token', refreshed.ok === true && refreshed.tokens.accessToken === 'access-refreshed', refreshed)

const refused = await refreshOAuthToken({ token_endpoint: discovery.metadata.token_endpoint }, { clientId: registration.clientId, refreshToken: 'revoked-refresh' })
check(
  'a refused token request carries the server reason for the panel',
  refused.ok === false &&
    refused.reason === 'invalid_grant' &&
    refused.status === 400 &&
    refused.message.includes('Invalid or expired refresh token'),
  refused,
)

const denied = await exchangeAuthorizationCode(
  discovery.metadata,
  { clientId: registration.clientId, code: 'code-1', verifier: 'wrong-verifier', redirectUri: 'http://127.0.0.1:49869/docsmint/oauth/callback' },
)
check('a wrong verifier is refused', denied.ok === false && denied.status === 400, denied)

/* -------------------------- transport security ---------------------------- */
let redirected = 0
const reflectedKey = 'fixture-access-secret-never-return'
const reflectedRefresh = 'fixture-refresh-secret-never-return'
const securityServer = createServer(async (req, res) => {
  if (req.url === '/sink') { redirected++; json(res, 200, { access_token: 'wrong' }); return }
  if (req.url === '/redirect307' || req.url === '/redirect308') {
    res.writeHead(req.url.endsWith('307') ? 307 : 308, { location: '/sink' }); res.end(); return
  }
  if (req.url === '/oversized') {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': 1048577 })
    res.end('x'.repeat(1048577)); return
  }
  if (req.url === '/token-error') { json(res, 400, { error: reflectedRefresh, error_description: reflectedRefresh }); return }
  if (req.url === '/http-error') { json(res, 403, { error: reflectedKey }); return }
  let body = ''
  for await (const chunk of req) body += chunk
  const request = JSON.parse(body)
  if (req.url === '/rpc-error') {
    json(res, 200, { jsonrpc: '2.0', id: request.id, error: { code: -32602, message: reflectedKey, data: { secret: reflectedKey } } }); return
  }
  json(res, 200, { jsonrpc: '2.0', id: request.id, result: { secret: reflectedKey } })
})
await new Promise(resolve => securityServer.listen(0, '127.0.0.1', resolve))
const securityOrigin = `http://127.0.0.1:${securityServer.address().port}`
try {
  for (const status of [307, 308]) {
    const target = `${securityOrigin}/redirect${status}`
    const token = await refreshOAuthToken({ token_endpoint: target }, { clientId: 'fixture', refreshToken: reflectedRefresh })
    check(`token ${status} redirects are rejected without forwarding secrets`, !token.ok && redirected === 0, token)
    const bearer = await createMcpSession({ endpoint: target, authorize: async () => ({ headers: { authorization: `Bearer ${reflectedKey}` } }) }).invoke('list', {})
    check(`Bearer ${status} redirects are rejected`, !bearer.ok && redirected === 0, bearer)
  }
  const tokenError = await refreshOAuthToken({ token_endpoint: `${securityOrigin}/token-error` }, { clientId: 'fixture', refreshToken: reflectedRefresh })
  check('token errors never echo refresh credentials', !tokenError.ok && !JSON.stringify(tokenError).includes(reflectedRefresh), tokenError)
  for (const path of ['/http-error', '/rpc-error', '/reflected-success', '/oversized']) {
    const result = await createMcpSession({ endpoint: securityOrigin + path, authorize: async () => ({ headers: { Authorization: `Bearer ${reflectedKey}` } }) }).invoke('list', {})
    check(`MCP ${path} fails safely without exposing access credentials`, !result.ok && !JSON.stringify(result).includes(reflectedKey), result)
  }
  const oversizedToken = await refreshOAuthToken({ token_endpoint: `${securityOrigin}/oversized` }, { clientId: 'fixture', refreshToken: reflectedRefresh })
  check('oversized token response is rejected before parsing', oversizedToken.code === 'response-rejected', oversizedToken)
  const originalFetch = globalThis.fetch
  let cancelled = false
  try {
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(1048577)) },
      cancel() { cancelled = true },
    }), { headers: { 'content-type': 'text/event-stream' } })
    const bounded = await createMcpSession({ endpoint: securityOrigin + '/stream', authorize: async () => ({ headers: { authorization: `Bearer ${reflectedKey}` } }) }).invoke('list', {})
    check('oversized chunked SSE is rejected and cancelled', bounded.code === 'response-rejected' && cancelled, bounded)
  } finally { globalThis.fetch = originalFetch }
} finally {
  await new Promise(resolve => securityServer.close(resolve))
}

server.close()

if (failures.length > 0) {
  console.log(`\n${failures.length} failing check(s): ${failures.join('; ')}`)
  process.exitCode = 1
} else {
  console.log('\nall checks passed')
}
