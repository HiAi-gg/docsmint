/**
 * DocsMint MCP transport for the bundle's Host half.
 *
 * One file covers the two halves the MCP mode needs: a Streamable-HTTP JSON-RPC
 * client (the transport DocsMint Cloud publishes at `/mcp`) and the OAuth 2.1
 * authorization-code flow that endpoint advertises, with dynamic client
 * registration and PKCE S256.
 *
 * Tool names and argument names come from the server's own `tools/list`, so the
 * same three operations keep working when the inventory grows.
 */

const PROTOCOL_VERSION = '2025-06-18'
const CLIENT_NAME = 'DeepSeek Harness DocsMint'

/** @type {number} */
let requestId = 0

const MAX_RESPONSE_BYTES = 1024 * 1024

/** Bound JSON and SSE responses before parsing; cancel oversized streams. */
async function boundedText(response) {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel()
    throw new Error('Response exceeds limit')
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let text = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return text + decoder.decode()
      size += value.byteLength
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        throw new Error('Response exceeds limit')
      }
      text += decoder.decode(value, { stream: true })
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * @param {string} code - machine code.
 * @param {string} message - human-readable message.
 * @param {number} [status] - HTTP status, 0 for transport failures.
 * @returns {{ ok: false, code: string, message: string, status: number }} a failure.
 */
function failure(code, message, status = 0) {
  return { ok: false, code, message, status }
}

/**
 * @param {unknown} value
 * @returns {string | undefined} the trimmed non-empty string.
 */
function str(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/**
 * @param {Uint8Array | ArrayBuffer} bytes
 * @returns {string} base64url without padding.
 */
function base64url(bytes) {
  return Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/**
 * @param {number} [bytes] - entropy size.
 * @returns {string} an unguessable URL-safe token.
 */
export function randomToken(bytes = 32) {
  const buffer = new Uint8Array(bytes)
  globalThis.crypto.getRandomValues(buffer)
  return base64url(buffer)
}

/**
 * @returns {Promise<{ verifier: string, challenge: string }>} a PKCE S256 pair.
 */
export async function pkcePair() {
  const verifier = randomToken(48)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return { verifier, challenge: base64url(digest) }
}

/**
 * @param {string} text - response body.
 * @param {string} contentType - response content type.
 * @returns {any[]} decoded JSON-RPC messages.
 */
function messagesFrom(text, contentType) {
  const trimmed = text.trim()
  if (!trimmed) return []
  if (contentType.includes('text/event-stream')) {
    const messages = []
    for (const block of trimmed.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('')
      if (!data) continue
      try {
        messages.push(JSON.parse(data))
      } catch {
        // A partial SSE frame is not an answer; keep looking.
      }
    }
    return messages
  }
  try {
    const parsed = JSON.parse(trimmed)
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return []
  }
}

/**
 * @param {number} status - HTTP status.
 * @param {string} text - response body.
 * @returns {string} a message that names the next action.
 */
function describeHttp(status, text) {
  // Upstream error bodies may echo Authorization or OAuth form secrets.
  if (status === 401) return 'The DocsMint MCP endpoint rejected the credential (401). Reconnect it in the DocsMint panel.'
  if (status === 403) return 'The MCP credential lacks access (403).'
  if (status === 404) return 'This DocsMint deployment does not serve /mcp (404). Use API mode, or run the OSS stdio server docsmint-mcp.'
  if (status === 405) return 'This endpoint does not accept POST /mcp (405); MCP over HTTP is not enabled there.'
  return `DocsMint MCP request failed (${status}).`
}

/**
 * One JSON-RPC round trip over Streamable HTTP.
 *
 * @param {string} endpoint - the `/mcp` URL.
 * @param {{ headers: Record<string, string> }} auth - authorization outcome.
 * @param {string | undefined} sessionId - `Mcp-Session-Id` when the server issued one.
 * @param {string} method - JSON-RPC method.
 * @param {object} params - method params.
 * @param {AbortSignal | undefined} signal - cancellation.
 * @returns {Promise<any>} `{ ok: true, result, sessionId }` or a failure.
 */
async function rpcOnce(endpoint, auth, sessionId, method, params, signal) {
  const id = ++requestId
  /** @type {Record<string, string>} */
  const headers = {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    'mcp-protocol-version': PROTOCOL_VERSION,
    ...(auth?.headers ?? {}),
  }
  if (sessionId) headers['mcp-session-id'] = sessionId

  let response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }),
      signal,
      redirect: 'error',
    })
  } catch (error) {
    if (signal?.aborted) return failure('aborted', 'The DocsMint MCP request was cancelled.')
    return failure('network', 'Could not reach the DocsMint MCP endpoint.')
  }

  let text
  try { text = await boundedText(response) } catch { return failure('response-rejected', 'DocsMint returned an unreadable or oversized response.', response.status) }
  const issued = str(response.headers.get('mcp-session-id'))
  if (!response.ok) {
    return { ...failure(`mcp-${response.status}`, describeHttp(response.status, text), response.status), sessionId: issued }
  }

  const messages = messagesFrom(text, response.headers.get('content-type') ?? '')
  const answer = messages.find((message) => message && message.id === id) ?? messages[messages.length - 1]
  if (!answer) return { ok: true, result: undefined, sessionId: issued }
  if (answer.error) {
    return { ...failure('mcp-error', 'The DocsMint MCP server rejected the request.', 200), sessionId: issued }
  }
  const credential = str(new Headers(auth?.headers).get('authorization'))?.replace(/^Bearer\s+/i, '')
  if (credential && JSON.stringify(answer.result ?? null).includes(credential)) return failure('response-rejected', 'DocsMint returned a credential-bearing response.', 200)
  return { ok: true, result: answer.result, sessionId: issued }
}

/** Tool-name preferences per operation, most specific first. */
const TOOL_NAMES = {
  search: ['find_documents', 'search_documents', 'search_docs', 'search', 'documents_search'],
  list: ['list_documents', 'find_documents', 'list_docs', 'documents_list'],
  get: ['read_document', 'get_document', 'documents_get', 'fetch_document'],
  create: ['save_document', 'create_document', 'documents_create', 'write_document'],
  update: ['save_document', 'update_document', 'documents_update'],
  workspaces: ['list_workspace_structure', 'list_workspaces'],
  folders: ['list_workspace_structure', 'list_folders'],
  categories: ['list_workspace_structure', 'list_categories'],
  'create-folder': ['save_folder', 'create_folder'],
  'create-category': ['save_category', 'create_category'],
}

/** The discriminator value each operation needs, most likely first. */
const OPERATION_VALUES = {
  search: ['search', 'query', 'find', 'semantic'],
  list: ['list', 'browse', 'all', 'recent'],
  get: ['detail', 'markdown', 'read', 'get', 'document', 'view'],
  create: ['create', 'write', 'new', 'add'],
  update: ['update', 'edit', 'save'],
  workspaces: ['workspaces', 'list', 'all'],
  folders: ['folders', 'list', 'all'],
  categories: ['categories', 'list', 'all'],
  'create-folder': ['create'],
  'create-category': ['create'],
}

/** Names that select an operation inside one multi-purpose tool. */
const DISCRIMINATOR_NAMES = ['mode', 'action', 'operation', 'view', 'op', 'type', 'kind']

/** Argument-name candidates per canonical input. */
const ARG_NAMES = {
  query: ['query', 'q', 'text', 'search', 'queryText', 'term'],
  limit: ['limit', 'maxResults', 'count', 'pageSize', 'topK', 'k'],
  page: ['page', 'pageNumber'],
  id: ['id', 'documentId', 'docId', 'document_id', 'document'],
  title: ['title', 'name', 'documentTitle'],
  name: ['name', 'title'],
  content: ['content', 'markdown', 'body', 'text'],
  folderId: ['folderId', 'folder_id', 'parentId', 'folder'],
  categoryId: ['categoryId', 'category_id', 'category'],
  workspaceId: ['workspaceId', 'workspace_id', 'workspace'],
}

/**
 * @param {any[]} tools - server tool listing.
 * @param {keyof typeof TOOL_NAMES} kind - operation.
 * @returns {any | undefined} the selected tool.
 */
function pickTool(tools, kind) {
  const preferred = TOOL_NAMES[kind]
  for (const name of preferred) {
    const exact = tools.find((tool) => typeof tool?.name === 'string' && tool.name === name)
    if (exact) return exact
  }
  for (const name of preferred) {
    const loose = tools.find((tool) => typeof tool?.name === 'string' && tool.name.toLowerCase().includes(name))
    if (loose) return loose
  }
  return undefined
}

/**
 * Collect the string values a discriminator schema allows. A discriminated union
 * publishes them as `const` branches, a plain union as `enum`.
 *
 * @param {any} schema - the discriminator's schema.
 * @returns {string[]} every allowed value.
 */
function enumValues(schema) {
  if (!schema || typeof schema !== 'object') return []
  const values = []
  if (typeof schema.const === 'string') values.push(schema.const)
  if (Array.isArray(schema.enum)) {
    for (const value of schema.enum) if (typeof value === 'string') values.push(value)
  }
  for (const key of ['anyOf', 'oneOf']) {
    if (Array.isArray(schema[key])) {
      for (const branch of schema[key]) values.push(...enumValues(branch))
    }
  }
  return values
}

/**
 * Choose the value a discriminator argument needs for one operation. A tool that
 * serves several operations (DocsMint's `find_documents`, `read_document`,
 * `save_document`) declares one `const` per operation.
 *
 * @param {string} kind - operation.
 * @param {any} schema - that argument's schema.
 * @returns {string | undefined} the matching value.
 */
function enumFor(kind, schema) {
  const values = enumValues(schema)
  if (values.length === 0) return undefined
  const wanted = OPERATION_VALUES[kind] ?? []
  for (const candidate of wanted) {
    const hit = values.find((value) => value.toLowerCase() === candidate)
    if (hit) return hit
  }
  return undefined
}

/**
 * Collect every object schema inside a tool's `inputSchema`, including the
 * branches of a union. A tool built from a discriminated union publishes one
 * branch per operation instead of one flat property list.
 *
 * @param {any} schema - a schema node.
 * @returns {any[]} the object-shaped nodes.
 */
function objectNodes(schema) {
  const nodes = []
  if (!schema || typeof schema !== 'object') return nodes
  if (schema.properties && typeof schema.properties === 'object') nodes.push(schema)
  for (const key of ['oneOf', 'anyOf', 'allOf']) {
    if (Array.isArray(schema[key])) {
      for (const branch of schema[key]) nodes.push(...objectNodes(branch))
    }
  }
  return nodes
}

/**
 * @param {any} schema - an object schema node.
 * @returns {string | undefined} the property that discriminates its operations.
 */
function discriminatorName(schema) {
  const properties = schema?.properties ?? {}
  return DISCRIMINATOR_NAMES.find((name) => properties[name] !== undefined)
}

/**
 * Pick the schema node that describes one operation, so the arguments come from
 * that operation's own branch.
 *
 * @param {any} tool - the selected tool.
 * @param {string} kind - operation.
 * @returns {{ properties: Record<string, any>, required: string[], discriminator?: string, value?: string }} the node.
 */
function operationSchema(tool, kind) {
  const nodes = objectNodes(tool?.inputSchema)
  if (nodes.length === 0) return { properties: {}, required: [] }
  let chosen
  let chosenValue
  for (const node of nodes) {
    const name = discriminatorName(node)
    if (!name) continue
    const value = enumFor(kind, node.properties[name])
    if (value !== undefined) {
      chosen = node
      chosenValue = value
      break
    }
  }
  const node = chosen ?? nodes[0]
  const name = discriminatorName(node)
  return {
    properties: node.properties ?? {},
    required: Array.isArray(node.required) ? node.required : [],
    discriminator: name,
    value: chosenValue ?? (name ? enumFor(kind, node.properties[name]) : undefined),
  }
}

/**
 * @param {any} tool - selected tool.
 * @param {string} kind - operation the call serves.
 * @param {Record<string, any>} input - canonical input.
 * @returns {{ args: Record<string, any>, missing: string[] }} arguments the tool's own schema accepts, and required ones that could not be derived.
 */
function mapArgs(tool, kind, input) {
  const shape = operationSchema(tool, kind)
  const declared = Object.keys(shape.properties)
  /** @type {Record<string, any>} */
  const args = {}
  for (const [canonical, value] of Object.entries(input)) {
    if (value === undefined || value === null || value === '') continue
    if (declared.length === 0) {
      args[canonical] = value
      continue
    }
    const candidate = (ARG_NAMES[canonical] ?? [canonical]).find((name) => declared.includes(name))
    if (candidate && args[candidate] === undefined) args[candidate] = value
  }
  if (shape.discriminator && shape.value !== undefined && args[shape.discriminator] === undefined) {
    args[shape.discriminator] = shape.value
  }
  for (const name of shape.required) {
    if (args[name] !== undefined) continue
    const chosen = enumFor(kind, shape.properties[name])
    if (chosen !== undefined) args[name] = chosen
  }
  return { args, missing: shape.required.filter((name) => args[name] === undefined) }
}

/**
 * @param {any} result - `tools/call` result.
 * @returns {{ text: string, base: any, isError: boolean }} decoded payload.
 */
function payloadOf(result) {
  const blocks = Array.isArray(result?.content) ? result.content : []
  const text = blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
  let base = result?.structuredContent && typeof result.structuredContent === 'object' ? result.structuredContent : undefined
  if (!base && text) {
    const trimmed = text.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        base = JSON.parse(trimmed)
      } catch {
        base = undefined
      }
    }
  }
  return { text, base, isError: result?.isError === true }
}

/**
 * @param {any} base - decoded payload.
 * @returns {any[]} list-shaped rows from the many plausible envelopes.
 */
function scopedResultsOf(base) {
  return Array.isArray(base?.scopedResults) ? base.scopedResults : undefined
}
function scopedRow(row, scope) {
  return { ...row,
    workspaceId: str(scope?.workspace?.id) ?? str(row?.workspaceId),
    workspaceSlug: str(scope?.workspace?.slug) ?? str(row?.workspaceSlug),
  }
}
function failedScope(scope) {
  return Boolean(scope?.error || scope?.data?.error || scope?.data?.isError || scope?.data?.result?.isError)
}
function scopeMetadata(base) {
  const scopes = scopedResultsOf(base)
  return scopes ? { scopedResults: scopes, pagination: 'per-scope', totalIsGlobal: false,
    ...(scopes.some(failedScope) ? { partial: true } : {}) } : {}
}

function itemsOf(base) {
  if (!base) return []
  if (Array.isArray(base)) return base
  if (typeof base !== 'object') return []
  const scopes = scopedResultsOf(base)
  if (scopes) return scopes.flatMap(scope => failedScope(scope) ? [] : itemsOf(scope.data).map(row => scopedRow(row, scope)))
  for (const key of ['items', 'results', 'documents', 'hits', 'rows', 'result', 'data', 'payload']) {
    const value = base[key]
    if (Array.isArray(value)) return value
    if (value && typeof value === 'object') {
      const nested = itemsOf(value)
      if (nested.length > 0) return nested
    }
  }
  return []
}

/**
 * @param {any} base - decoded payload.
 * @returns {number | undefined} a declared total, from the envelope or its payload.
 */
function totalOf(base) {
  // Separate scoped pages may overlap and must not be summed as a global total.
  if (scopedResultsOf(base)) return undefined
  for (const source of [base, base?.result, base?.data, base?.payload]) {
    if (!source || typeof source !== 'object') continue
    const total = source.total ?? source.count ?? source.totalCount
    if (typeof total === 'number' && Number.isFinite(total)) return total
  }
  return undefined
}

/**
 * @param {any} raw - one row from the MCP payload.
 * @returns {any} a REST-list-shaped row, so both modes normalize identically.
 */
function toRow(raw) {
  const row = raw && typeof raw === 'object' ? raw : {}
  const tags = Array.isArray(row.tags) ? row.tags.map((tag) => ({ name: str(tag?.name) ?? str(tag) })).filter((tag) => tag.name) : []
  return {
    id: str(row.id) ?? str(row.documentId) ?? str(row.docId) ?? '',
    title: str(row.title) ?? str(row.name) ?? 'Untitled document',
    content: str(row.content) ?? str(row.snippet) ?? str(row.preview) ?? '',
    snippet: str(row.snippet) ?? str(row.preview) ?? '',
    score: typeof row.score === 'number' ? row.score : undefined,
    folder_name: str(row.folder_name) ?? str(row.folderName) ?? str(row.folder),
    category_name: str(row.category_name) ?? str(row.categoryName) ?? str(row.category),
    updated_at: str(row.updated_at) ?? str(row.updatedAt) ?? str(row.modifiedAt),
    created_at: str(row.created_at) ?? str(row.createdAt),
    visibility: str(row.visibility),
    workspaceId: str(row.workspaceId),
    workspaceSlug: str(row.workspaceSlug),
    url: str(row.url),
    folderId: str(row.folderId) ?? str(row.folder_id),
    categoryId: str(row.categoryId) ?? str(row.category_id),
    tags,
  }
}

/**
 * @param {any} node - a candidate object.
 * @returns {any | undefined} the node when it looks like a document.
 */
function asDocument(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return undefined
  if (str(node.id) || str(node.title) || typeof node.content === 'string' || typeof node.markdown === 'string') {
    return node
  }
  return undefined
}

/**
 * @param {any} base - decoded payload.
 * @returns {any | undefined} a single document object from the envelope.
 */
function documentOf(base) {
  if (!base) return undefined
  if (Array.isArray(base)) return base.length === 1 ? asDocument(base[0]) : undefined
  if (typeof base !== 'object') return undefined
  const scopes = scopedResultsOf(base)
  if (scopes) {
    if (scopes.some(failedScope)) return undefined
    const docs = scopes.flatMap(scope => { const doc = documentOf(scope.data); return doc ? [scopedRow(doc, scope)] : [] })
    return docs.length === 1 ? docs[0] : undefined
  }
  const direct = asDocument(base)
  if (direct) return direct
  for (const key of ['document', 'doc', 'result', 'data', 'payload']) {
    const value = base[key]
    const nested = asDocument(value) ?? (value && typeof value === 'object' ? documentOf(value) : undefined)
    if (nested) return nested
  }
  const rows = itemsOf(base)
  return rows.length === 1 ? asDocument(rows[0]) : undefined
}

/**
 * @param {string} text - tool text, possibly Markdown.
 * @param {string} fallback - fallback title.
 * @returns {string} a title taken from the first heading, else the fallback.
 */
function titleFromText(text, fallback) {
  const heading = text.split(/\r?\n/).find((line) => line.startsWith('# '))
  return heading ? heading.slice(2).trim() || fallback : fallback
}

/**
 * Turn one MCP tool result into the REST-shaped payload the bridge already
 * understands, so `listItems`, `searchItems` and `normalizeDocument` keep
 * working unchanged for both transports.
 *
 * @param {string} kind - operation.
 * @param {any} result - `tools/call` result.
 * @param {Record<string, any>} input - canonical input.
 * @returns {any} an operation outcome with REST-shaped data.
 */
function shape(kind, result, input) {
  const payload = payloadOf(result)
  if (payload.isError) {
    return failure('mcp-tool-error', 'The DocsMint MCP tool reported an error.', 200)
  }

  // A structure listing answers with a bare array of rows (workspaces carry `slug`).
  if (kind === 'workspaces' || kind === 'folders' || kind === 'categories') {
    return { ok: true, status: 200, data: { items: itemsOf(payload.base), ...scopeMetadata(payload.base) } }
  }

  if (kind === 'create-folder' || kind === 'create-category') {
    const entity = documentOf(payload.base) ?? itemsOf(payload.base)[0] ?? {}
    return {
      ok: true,
      status: 200,
      data: {
        id: str(entity.id) ?? '',
        name: str(entity.name) ?? str(entity.title) ?? str(input.name) ?? '',
        categoryId: str(entity.categoryId) ?? str(entity.category_id) ?? str(input.categoryId),
        parentId: str(entity.parentId) ?? str(entity.parent_id) ?? str(input.folderId),
      },
    }
  }

  if (kind === 'search' || kind === 'list') {
    const rows = itemsOf(payload.base).map(toRow)
    if (rows.length === 0 && payload.text && !scopedResultsOf(payload.base)) {
      const fallback = toRow({ content: payload.text, title: str(input.query) ?? 'DocsMint results' })
      return { ok: true, status: 200, data: { items: [], total: 0, text: payload.text, degraded: true, fallback } }
    }
    return { ok: true, status: 200, data: { items: rows, total: totalOf(payload.base) ?? rows.length, ...scopeMetadata(payload.base) } }
  }

  if (kind === 'get' || kind === 'update') {
    // A detail view carries the document; a markdown view carries only the body.
    const plain = typeof payload.base === 'string' ? payload.base : undefined
    const document = documentOf(payload.base)
    if (scopedResultsOf(payload.base) && !document) return failure('mcp-scoped-document', 'The MCP response did not identify exactly one successful scoped document.', 200)
    const identified = document && (str(document.id) || str(document.title))
    if (!identified) {
      const id = str(input.id) ?? ''
      const text = str(document?.markdown) ?? str(document?.content) ?? plain ?? payload.text
      return {
        ok: true,
        status: 200,
        data: {
          id,
          title: titleFromText(text, id ? `Document ${id}` : 'Document'),
          content: text,
        },
      }
    }
    const row = toRow(document)
    const content = str(document.content) ?? str(document.markdown) ?? plain ?? row.content ?? ''
    return { ok: true, status: 200, data: { ...row, content, ...scopeMetadata(payload.base) } }
  }

  const scopedDocument = documentOf(payload.base)
  if (scopedResultsOf(payload.base) && !scopedDocument) return failure('mcp-scoped-document', 'The MCP response did not identify exactly one successful scoped document.', 200)
  const document = scopedDocument ?? {}
  const id = str(document.id) ?? str(document.documentId) ?? ''
  const idFromText = payload.text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] ?? ''
  return {
    ok: true,
    status: 200,
    data: {
      id: id || idFromText,
      title: str(document.title) ?? str(input.title) ?? titleFromText(payload.text, 'Document'),
      content: '',
      workspaceId: str(document.workspaceId),
      workspaceSlug: str(document.workspaceSlug),
      url: str(document.url),
      ...scopeMetadata(payload.base),
    },
  }
}

/**
 * Create one MCP session for an endpoint. The session caches the server's tool
 * listing, so repeated calls cost one round trip.
 *
 * @param {{ endpoint: string, authorize: (force: boolean) => Promise<any>, signal?: AbortSignal }} options - session wiring.
 * @returns {{ invoke: (kind: 'search'|'list'|'get'|'create', input: Record<string, any>) => Promise<any>, info: () => any }} the session.
 */
export function createMcpSession(options) {
  const { endpoint, authorize, signal } = options
  /** @type {string | undefined} */
  let sessionId
  /** @type {any[] | undefined} */
  let tools
  /** @type {any} */
  let server

  async function rpc(method, params) {
    const auth = await authorize(false)
    if (!auth?.headers) return auth?.error ?? failure('mcp-no-credential', 'No DocsMint MCP credential is configured.', 401)
    let result = await rpcOnce(endpoint, auth, sessionId, method, params, signal)
    if (!result.ok && (result.status === 401 || result.code === 'mcp-401')) {
      const renewed = await authorize(true)
      if (renewed?.headers) result = await rpcOnce(endpoint, renewed, sessionId, method, params, signal)
    }
    if (result.sessionId) sessionId = result.sessionId
    return result
  }

  async function ensure() {
    if (tools) return { ok: true, tools, server }
    const initialized = await rpc('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: CLIENT_NAME, version: '1.0.0' },
    })
    if (!initialized.ok) return initialized
    server = initialized.result?.serverInfo
    const listed = await rpc('tools/list', {})
    if (!listed.ok) return listed
    tools = Array.isArray(listed.result?.tools) ? listed.result.tools : []
    return { ok: true, tools, server }
  }

  return {
    info: () => ({ tools: tools ? tools.length : null, server: str(server?.name) ?? null }),
    async invoke(kind, input) {
      const ready = await ensure()
      if (!ready.ok) return ready
      let tool = pickTool(ready.tools, kind)
      if (!tool && kind === 'list') {
        // A single `find_documents` tool usually serves both listing and search.
        tool = pickTool(ready.tools, 'search')
      }
      if (!tool) {
        return failure(
          'mcp-tool-missing',
          `The DocsMint MCP server exposes no tool for "${kind}" (available: ${ready.tools.map((entry) => entry.name).join(', ') || 'none'}).`,
          404,
        )
      }
      const mapped = mapArgs(tool, kind, input)
      if (mapped.missing.length > 0) {
        const declared = Object.keys(tool.inputSchema?.properties ?? {}).join(', ')
        return failure(
          'mcp-tool-args',
          `The DocsMint MCP tool "${tool.name}" requires ${mapped.missing.join(', ')}, which this plugin could not derive (its arguments: ${declared || 'undeclared'}).`,
          400,
        )
      }
      const called = await rpc('tools/call', { name: tool.name, arguments: mapped.args })
      if (!called.ok) return called
      return shape(kind, called.result, input)
    },
  }
}

/* ------------------------------------------------------------------------- *
 * OAuth 2.1 (authorization code + PKCE, dynamic client registration)
 * ------------------------------------------------------------------------- */

/**
 * @param {string} url - JSON URL.
 * @param {AbortSignal | undefined} signal - cancellation.
 * @returns {Promise<any | undefined>} the parsed document, when it loads.
 */
async function getJson(url, signal) {
  try {
    const response = await fetch(url, { headers: { accept: 'application/json' }, signal, redirect: 'error' })
    if (!response.ok) { await response.body?.cancel(); return undefined }
    return JSON.parse(await boundedText(response))
  } catch {
    return undefined
  }
}

/**
 * Read the protected-resource metadata and the authorization-server metadata the
 * MCP endpoint publishes.
 *
 * @param {string} origin - deployment origin, such as `https://docsmint.com`.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<any>} discovery outcome.
 */
export async function discoverAuthorization(origin, signal) {
  const resource = `${origin}/mcp`
  const prm = await getJson(`${origin}/.well-known/oauth-protected-resource/mcp`, signal)
  const issuer = str(prm?.authorization_servers?.[0]) ?? origin
  const metadata =
    (await getJson(`${issuer}/.well-known/oauth-authorization-server`, signal)) ??
    (await getJson(`${issuer}/.well-known/openid-configuration`, signal))
  if (!metadata || !str(metadata.authorization_endpoint) || !str(metadata.token_endpoint)) {
    return failure(
      'oauth-metadata',
      `The DocsMint authorization server at ${issuer} did not publish usable OAuth metadata.`,
      0,
    )
  }
  return {
    ok: true,
    resource: str(prm?.resource) ?? resource,
    scopes: Array.isArray(prm?.scopes_supported)
      ? prm.scopes_supported
      : Array.isArray(metadata.scopes_supported)
        ? metadata.scopes_supported
        : [],
    metadata,
    issuer,
  }
}

/**
 * Register a public client for one loopback redirect URI.
 *
 * @param {any} metadata - authorization-server metadata.
 * @param {{ redirectUri: string, scope?: string }} options - registration input.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<any>} `{ ok: true, clientId }` or a failure.
 */
export async function registerOAuthClient(metadata, options, signal) {
  const endpoint = str(metadata?.registration_endpoint)
  if (!endpoint) {
    return failure(
      'oauth-registration',
      'The DocsMint authorization server does not support dynamic client registration.',
      0,
    )
  }
  const body = {
    client_name: CLIENT_NAME,
    redirect_uris: [options.redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  }
  if (options.scope) body.scope = options.scope
  let response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
      redirect: 'error',
    })
  } catch (error) {
    if (signal?.aborted) return failure('aborted', 'OAuth registration was cancelled.')
    return failure('network', 'Could not register the DocsMint OAuth client.')
  }
  let text
  try { text = await boundedText(response) } catch { return failure('response-rejected', 'DocsMint returned an unreadable or oversized response.', response.status) }
  /** @type {any} */
  let data
  try {
    data = JSON.parse(text)
  } catch {
    data = undefined
  }
  if (!response.ok) {
    return failure('oauth-registration', `DocsMint refused the OAuth client registration (${response.status}).`, response.status)
  }
  const clientId = str(data?.client_id)
  if (!clientId) return failure('oauth-registration', 'The registration response carried no client_id.')
  return { ok: true, clientId }
}

/**
 * @param {any} metadata - authorization-server metadata.
 * @param {{ clientId: string, redirectUri: string, scope?: string, resource?: string, state: string, challenge: string }} input - authorization input.
 * @returns {string} the URL to open in the browser.
 */
export function authorizationUrl(metadata, input) {
  const url = new URL(metadata.authorization_endpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', input.clientId)
  url.searchParams.set('redirect_uri', input.redirectUri)
  url.searchParams.set('code_challenge', input.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', input.state)
  if (input.scope) url.searchParams.set('scope', input.scope)
  if (input.resource) url.searchParams.set('resource', input.resource)
  return url.toString()
}

/**
 * @param {string} tokenEndpoint - token URL.
 * @param {URLSearchParams} form - request body.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<any>} `{ ok: true, tokens }` or a failure.
 */
async function tokenRequest(tokenEndpoint, form, signal) {
  let response
  try {
    response = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal,
      redirect: 'error',
    })
  } catch (error) {
    if (signal?.aborted) return failure('aborted', 'The DocsMint token request was cancelled.')
    return failure('network', 'Could not reach the DocsMint token endpoint.')
  }
  let text
  try { text = await boundedText(response) } catch { return failure('response-rejected', 'DocsMint returned an unreadable or oversized response.', response.status) }
  /** @type {any} */
  let data
  try {
    data = JSON.parse(text)
  } catch {
    data = undefined
  }
  if (!response.ok) {
    // The description is server-controlled text: strip anything the request sent
    // as a credential, so a reflecting endpoint cannot leak it into the panel.
    const secrets = ['refresh_token', 'code', 'code_verifier']
      .map((key) => form.get(key))
      .filter((value) => typeof value === 'string' && value.length >= 8)
    const sanitize = (value) => {
      let out = value
      for (const secret of secrets) out = out.split(secret).join('[redacted]')
      return out.length > 200 ? `${out.slice(0, 200)}…` : out
    }
    const reason = str(data?.error)
    const description = str(data?.error_description)
    const detail = [reason, description].filter(Boolean).map(sanitize).join(': ')
    return {
      ...failure(
        'oauth-token',
        `DocsMint refused the token request (${response.status})${detail ? `: ${detail}` : '.'}`,
        response.status,
      ),
      reason: reason ? sanitize(reason) : undefined,
    }
  }
  const accessToken = str(data?.access_token)
  if (!accessToken) return failure('oauth-token', 'The token response carried no access_token.')
  const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 3600
  return {
    ok: true,
    tokens: {
      accessToken,
      refreshToken: str(data.refresh_token),
      expiresAt: Date.now() + expiresIn * 1000,
      scope: str(data.scope),
    },
  }
}

/**
 * @param {any} metadata - authorization-server metadata.
 * @param {{ clientId: string, code: string, verifier: string, redirectUri: string, resource?: string }} input - code exchange input.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<any>} `{ ok: true, tokens }` or a failure.
 */
export async function exchangeAuthorizationCode(metadata, input, signal) {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    code_verifier: input.verifier,
  })
  if (input.resource) form.set('resource', input.resource)
  return tokenRequest(str(metadata.token_endpoint), form, signal)
}

/**
 * @param {{ token_endpoint: string }} record - what the stored token record knows.
 * @param {{ clientId: string, refreshToken: string, resource?: string }} input - refresh input.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<any>} `{ ok: true, tokens }` or a failure.
 */
export async function refreshOAuthToken(record, input, signal) {
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: input.refreshToken,
    client_id: input.clientId,
  })
  if (input.resource) form.set('resource', input.resource)
  return tokenRequest(record.token_endpoint, form, signal)
}
