/**
 * DocsMint bundle — Host half.
 *
 * One DocsMint REST client serves three callers: the sidebar panel (through the
 * same-origin route this file registers), the agent tools registered on
 * `ctx.tools`, and therefore the model. The credential lives in the Harness
 * credential store, never in page code, and every call re-resolves it so a key
 * changed in the panel reaches the next call without a restart.
 *
 * @module @hiai-gg/dsh-docsmint
 */

import {
  authorizationUrl,
  createMcpSession,
  discoverAuthorization,
  exchangeAuthorizationCode,
  pkcePair,
  randomToken,
  refreshOAuthToken,
  registerOAuthClient,
} from './mcp.js'

/** Same-origin route the Web UI panel posts to. */
const RPC_PATH = '/docsmint/rpc'
/** Where the DocsMint authorization server redirects the browser back. */
const OAUTH_PATH = '/docsmint/oauth/callback'

/** Credential references (also honoured as environment-variable names). */
const KEY_REF = 'DOCSMINT_API_KEY'
const WORKSPACE_REF = 'DOCSMINT_WORKSPACE'
/** Holds `cloud` or a self-hosted API base chosen in the panel. */
const ENDPOINT_REF = 'DOCSMINT_ENDPOINT'
/** Holds `api` or `mcp`. */
const MODE_REF = 'DOCSMINT_MODE'
/** Holds the OAuth token record as one JSON secret. */
const OAUTH_REF = 'DOCSMINT_OAUTH'

/** The hosted deployment: the default every fresh install talks to. */
const CLOUD_BASE = 'https://docsmint.com/api/v1'

/** Fallbacks used when the Loader row, the panel and the store are all silent. */
const DEFAULTS = {
  pageSize: 20,
}

/** Agent tools this bundle registers. */
const TOOL_NAMES = [
  'docsmint_search',
  'docsmint_get_document',
  'docsmint_create_document',
  'docsmint_update_document',
]

/** Connection state belongs to its registering profile, never to the module. */
const contextStates = new WeakMap()
function stateFor(ctx) {
  let state = contextStates.get(ctx)
  if (!state) {
    state = { sessions: new Map(), workspaces: new Map(), pending: new Map(), refresh: null, generation: 0, active: true, mutations: Promise.resolve() }
    contextStates.set(ctx, state)
  }
  return state
}
function mutateCredentials(ctx, operation) {
  const state = stateFor(ctx)
  const pending = state.mutations.then(operation, operation)
  state.mutations = pending.catch(() => {})
  return pending
}
function invalidateContext(ctx, unload = false) {
  const state = stateFor(ctx)
  state.generation++
  state.sessions.clear()
  state.workspaces.clear()
  state.pending.clear()
  state.refresh = null
  if (unload) state.active = false
}

/**
 * @param {unknown} value
 * @returns {string | undefined} the trimmed non-empty string, otherwise undefined.
 */
function str(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/**
 * Drop absent fields: tool results must stay lossless JSON, and `undefined` is
 * not a JSON value.
 *
 * @param {Record<string, any>} object - candidate.
 * @returns {Record<string, any>} the same object without undefined entries.
 */
function compact(object) {
  /** @type {Record<string, any>} */
  const out = {}
  for (const [key, value] of Object.entries(object)) {
    if (value !== undefined) out[key] = value
  }
  return out
}

/**
 * @param {unknown} value
 * @returns {number} a finite number, otherwise NaN.
 */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN
}

/**
 * @param {unknown} value - candidate integer.
 * @param {number} min - inclusive lower bound.
 * @param {number} max - inclusive upper bound.
 * @param {number} fallback - used when the candidate is not a number.
 * @returns {number} the clamped integer.
 */
function clampInt(value, min, max, fallback) {
  const integer = Math.trunc(num(value))
  if (!Number.isFinite(integer)) return fallback
  return Math.min(max, Math.max(min, integer))
}

/**
 * @param {unknown} error
 * @returns {string} a human-readable message.
 */
function message(error) {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

/**
 * Derive the product origin from an API URL such as `https://docsmint.com/api/v1`.
 *
 * @param {string} apiBase - normalized API base URL.
 * @returns {string} the origin the web application is served from.
 */
function deriveWebBase(apiBase) {
  const marker = apiBase.indexOf('/api/')
  return (marker > 0 ? apiBase.slice(0, marker) : apiBase).replace(/\/+$/, '')
}

/**
 * Normalize a user-supplied instance URL to an `/api/v1` base. Accepts a bare
 * origin, an `/api` base or a complete `/api/v1` base, so a person can paste
 * whatever the self-hosted instance prints.
 *
 * @param {unknown} input - the URL as typed.
 * @returns {string | undefined} the API base, otherwise undefined when unusable.
 */
function normalizeApiBase(input) {
  const raw = str(input)
  if (!raw) return undefined
  let url
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  let path = url.pathname.replace(/\/+$/, '')
  if (path === '' || path === '/api') path = '/api/v1'
  else if (!/\/api\/v1$/.test(path)) path = `${path}/api/v1`
  return `${url.origin}${path}`
}

/**
 * @param {string} apiBase - a normalized API base.
 * @returns {'cloud' | 'self-hosted'} which deployment that base belongs to.
 */
function deploymentOf(apiBase) {
  try {
    return new URL(apiBase).origin === new URL(CLOUD_BASE).origin ? 'cloud' : 'self-hosted'
  } catch {
    return 'self-hosted'
  }
}

/**
 * @param {Record<string, unknown> | undefined} config - the Loader row config.
 * @returns {number} the configured default page size.
 */
function defaultPageSize(config) {
  return clampInt(config?.pageSize, 1, 50, DEFAULTS.pageSize)
}

/**
 * Read one credential, preferring the Harness credential store over the process
 * environment so that a key entered in the panel wins.
 *
 * @param {{ get(name: string): unknown }} ctx - registrant context.
 * @param {string} ref - credential reference, doubled as an environment name.
 * @param {string} [inline] - value taken from the plugin config, highest priority.
 * @returns {Promise<{ value: string, source: string } | undefined>} the credential.
 */
async function resolveCredential(ctx, ref, inline) {
  if (inline) return { value: inline, source: 'plugin config' }
  const credentials = /** @type {any} */ (ctx.get('credentials'))
  if (credentials && typeof credentials.resolve === 'function') {
    try {
      const resolved = await credentials.resolve(ref)
      const value = str(resolved?.value)
      if (value) return { value, source: str(resolved?.source) ?? 'credential store' }
    } catch {
      // A broken credential provider must not disable env fallback below.
    }
  }
  const env = str(globalThis.process?.env?.[ref])
  return env ? { value: env, source: `$${ref}` } : undefined
}

/**
 * Resolve which DocsMint deployment to talk to: an explicit patch override
 * first, then the endpoint the panel stored, then DocsMint Cloud.
 *
 * @param {{ get(name: string): unknown }} ctx - registrant context.
 * @param {Record<string, unknown> | undefined} config - the Loader row config.
 * @returns {Promise<{ apiBase: string, deployment: 'cloud' | 'self-hosted', source: string, locked: boolean, warning?: string }>} the endpoint.
 */
async function resolveEndpoint(ctx, config) {
  const pinned = normalizeApiBase(config?.baseUrl)
  if (pinned) {
    return { apiBase: pinned, deployment: deploymentOf(pinned), source: 'plugin config', locked: true }
  }
  const stored = await resolveCredential(ctx, ENDPOINT_REF)
  if (!stored) return { apiBase: CLOUD_BASE, deployment: 'cloud', source: 'default', locked: false }
  if (stored.value === 'cloud') {
    return { apiBase: CLOUD_BASE, deployment: 'cloud', source: stored.source, locked: false }
  }
  const normalized = normalizeApiBase(stored.value)
  if (!normalized) {
    return {
      apiBase: CLOUD_BASE,
      deployment: 'cloud',
      source: 'default',
      locked: false,
      warning: `Ignored an unusable stored endpoint (${stored.value}).`,
    }
  }
  return { apiBase: normalized, deployment: deploymentOf(normalized), source: stored.source, locked: false }
}

/**
 * @param {{ get(name: string): unknown }} ctx - registrant context.
 * @param {Record<string, unknown> | undefined} config - the Loader row config.
 * @returns {Promise<{ apiBase: string, webBase: string, pageSize: number, deployment: 'cloud' | 'self-hosted', endpointSource: string, endpointLocked: boolean, endpointWarning?: string, apiKey?: string, keySource?: string, workspace?: string, workspaceSource?: string }>} the connection.
 */
async function resolveConnection(ctx, config) {
  return mutateCredentials(ctx, () => resolveConnectionSnapshot(ctx, config))
}
async function resolveConnectionSnapshot(ctx, config) {
  const generation = stateFor(ctx).generation
  const endpoint = await resolveEndpoint(ctx, config)
  const mode = await resolveMode(ctx, config)
  const key = await resolveCredential(ctx, KEY_REF, str(config?.apiKey))
  const workspace = await resolveCredential(ctx, WORKSPACE_REF, str(config?.workspace))
  const webBase = (str(config?.webBaseUrl) ?? deriveWebBase(endpoint.apiBase)).replace(/\/+$/, '')
  const pinnedDeployment = str(config?.deployment)
  const deployment =
    pinnedDeployment === 'cloud' || pinnedDeployment === 'self-hosted' ? pinnedDeployment : endpoint.deployment
  return {
    generation,
    apiBase: endpoint.apiBase,
    webBase,
    deployment,
    endpointSource: endpoint.source,
    endpointLocked: endpoint.locked,
    endpointWarning: endpoint.warning,
    mode: mode.mode,
    modeSource: mode.source,
    modeLocked: mode.locked,
    pageSize: defaultPageSize(config),
    apiKey: stateFor(ctx).blocked ? undefined : key?.value,
    keySource: key?.source,
    workspace: workspace?.value,
    workspaceSource: workspace?.source,
  }
}

/**
 * Resolve the connection type used for this deployment: an explicit patch
 * override first, then the choice the panel stored, then the REST API.
 *
 * @param {any} ctx - registrant context.
 * @param {Record<string, unknown> | undefined} config - the Loader row config.
 * @returns {Promise<{ mode: 'api' | 'mcp', source: string, locked: boolean }>} the mode.
 */
async function resolveMode(ctx, config) {
  const pinned = str(config?.mode)
  if (pinned === 'api' || pinned === 'mcp') return { mode: pinned, source: 'plugin config', locked: true }
  const stored = await resolveCredential(ctx, MODE_REF)
  if (stored?.value === 'api' || stored?.value === 'mcp') {
    return { mode: stored.value, source: stored.source, locked: false }
  }
  return { mode: 'api', source: 'default', locked: false }
}

/**
 * @param {any} ctx - registrant context.
 * @returns {Promise<any | undefined>} the stored OAuth token record.
 */
async function readOAuthRecord(ctx) {
  const stored = await resolveCredential(ctx, OAUTH_REF)
  if (!stored?.value) return undefined
  try {
    const parsed = JSON.parse(stored.value)
    return parsed && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Drop only the OAuth record whose refresh was refused.
 * @param {any} ctx - registrant context.
 * @param {any} expectedRecord - the record used for the refresh request.
 * @param {number} generation - the connection generation at refresh start.
 * @returns {Promise<boolean>} false if a newer connection must be preserved.
 */
async function clearOAuthRecord(ctx, expectedRecord, generation) {
  const credentials = /** @type {any} */ (ctx.get('credentials'))
  if (!credentials || typeof credentials.unset !== 'function') return true
  const state = stateFor(ctx)
  try {
    return await mutateCredentials(ctx, async () => {
      if (!state.active || state.generation !== generation) return false
      const current = await readOAuthRecord(ctx)
      if (!state.active || state.generation !== generation) return false
      if (JSON.stringify(current) !== JSON.stringify(expectedRecord)) return false
      await credentials.unset(OAUTH_REF)
      return true
    })
  } catch {
    // Best effort: the caller already reports that authorization is required.
    return true
  }
}

/**
 * @param {any} ctx - registrant context.
 * @param {any} record - the token record to persist.
 * @returns {Promise<void>}
 */
async function writeOAuthRecord(ctx, record) {
  const credentials = /** @type {any} */ (ctx.get('credentials'))
  if (!credentials || typeof credentials.set !== 'function') {
    throw new Error('This profile has no credential store, so the OAuth token cannot be saved.')
  }
  const state = stateFor(ctx)
  const generation = state.generation
  await mutateCredentials(ctx, async () => {
    if (!state.active || state.generation !== generation) throw new Error('connection-changed')
    const previous = await resolveCredential(ctx, OAUTH_REF)
    if (!state.active || state.generation !== generation) throw new Error('connection-changed')
    await credentials.set(OAUTH_REF, JSON.stringify(record))
    // The store itself may be asynchronous. Restore the previous persisted
    // record before releasing the queue if unload/config changed during set.
    // A queued disconnect unset runs after this compensation.
    if (!state.active || state.generation !== generation) {
      if (previous?.value) await credentials.set(OAUTH_REF, previous.value)
      else if (typeof credentials.unset === 'function') await credentials.unset(OAUTH_REF)
      else await credentials.set(OAUTH_REF, '')
      throw new Error('connection-changed')
    }
  })
}

/**
 * Authorization headers for the deployment's MCP endpoint. DocsMint Cloud uses
 * the OAuth access token (refreshed on demand); a self-hosted instance uses its
 * API key as a Bearer token.
 *
 * @param {any} ctx - registrant context.
 * @param {Record<string, unknown> | undefined} config - the Loader row config.
 * @param {any} connection - resolved connection.
 * @param {boolean} force - refresh even when the token still looks fresh.
 * @returns {Promise<{ headers: Record<string, string> } | { error: any }>} the headers or a failure.
 */
async function ensureMcpAuth(ctx, config, connection, force = false) {
  if (stateFor(ctx).blocked || connection.generation !== stateFor(ctx).generation) return { error: failure('connection-changed', 'The DocsMint connection changed.', 409) }
  if (!stateFor(ctx).active) return { error: failure('context-unloaded', 'The DocsMint profile was unloaded.', 409) }
  if (connection.deployment === 'cloud') {
    const record = await readOAuthRecord(ctx)
    if (connection.generation !== stateFor(ctx).generation) return { error: failure('connection-changed', 'The DocsMint connection changed.', 409) }
    if (!record?.access_token) {
      return {
        error: failure(
          'mcp-needs-oauth',
          'DocsMint Cloud MCP is authorized through the OAuth flow. Press "Connect with OAuth" in the DocsMint panel.',
          401,
        ),
      }
    }
    const expiresAt = Number(record.expires_at) || 0
    if (!force && expiresAt - Date.now() > 60_000) {
      return { headers: { authorization: `Bearer ${record.access_token}` } }
    }
    if (!record.refresh_token) {
      if (expiresAt > Date.now() && !force) return { headers: { authorization: `Bearer ${record.access_token}` } }
      return {
        error: failure('mcp-token-expired', 'The DocsMint Cloud OAuth token expired. Reconnect it in the DocsMint panel.', 401),
      }
    }
    const state = stateFor(ctx)
    if (!state.active) return { error: failure('context-unloaded', 'The DocsMint profile was unloaded.', 409) }
    if (state.refresh) return state.refresh
    const generation = state.generation
    const refresh = (async () => {
      const refreshed = await refreshOAuthToken(
        { token_endpoint: record.token_endpoint },
        { clientId: record.client_id, refreshToken: record.refresh_token, resource: record.resource },
      )
      if (!refreshed.ok) {
        // A revoked or expired refresh token is terminal: drop the dead record so
        // the panel asks for a fresh consent instead of replaying a doomed 400 on
        // every request until the user works out that reconnecting is the fix.
        if (refreshed.reason === 'invalid_grant') {
          if (!(await clearOAuthRecord(ctx, record, generation))) {
            return { error: failure('connection-changed', 'The DocsMint connection changed. Retry the request.', 409) }
          }
          return {
            error: failure(
              'mcp-needs-oauth',
              'The DocsMint Cloud authorization expired or was revoked. Press "Connect with OAuth" in the DocsMint panel to authorize again.',
              401,
            ),
          }
        }
        return { error: refreshed }
      }
      if (!state.active || state.generation !== generation) return { error: failure('connection-changed', 'The DocsMint connection changed. Retry the request.', 409) }
      const next = { ...record, access_token: refreshed.tokens.accessToken, refresh_token: refreshed.tokens.refreshToken ?? record.refresh_token, expires_at: refreshed.tokens.expiresAt }
      await writeOAuthRecord(ctx, next)
      return { headers: { authorization: `Bearer ${next.access_token}` } }
    })()
    state.refresh = refresh
    try { return await refresh } finally { if (state.refresh === refresh) state.refresh = null }

  }

  const key = connection.apiKey
  if (!key) return { error: failure('mcp-no-key', 'MCP for a self-hosted DocsMint needs an API key from that instance.', 401) }
  const headers = { authorization: `Bearer ${key}` }
  if (connection.workspace) headers['x-docsmint-workspace'] = connection.workspace
  return { headers }
}

/**
 * @param {any} ctx - registrant context.
 * @param {Record<string, unknown> | undefined} config - the Loader row config.
 * @param {any} connection - resolved connection.
 * @returns {{ invoke: Function, info: Function }} the MCP session for this endpoint.
 */
function mcpSessionFor(ctx, config, connection) {
  const endpoint = `${connection.webBase}/mcp`
  const cacheKey = `${endpoint}|${connection.deployment}`
  const cached = stateFor(ctx).sessions.get(cacheKey)
  if (cached) return cached
  const session = createMcpSession({
    endpoint,
    authorize: (force) => ensureMcpAuth(ctx, config, connection, force),
  })
  stateFor(ctx).sessions.set(cacheKey, session)
  return session
}

/**
 * @param {any} ctx - registrant context.
 * @param {Record<string, unknown> | undefined} config - the Loader row config.
 * @param {any} connection - resolved connection.
 * @param {'search' | 'list' | 'get' | 'create'} kind - operation.
 * @param {Record<string, any>} input - canonical input.
 * @returns {Promise<any>} the REST-shaped operation outcome.
 */
async function mcpInvoke(ctx, config, connection, kind, input) {
  return mcpSessionFor(ctx, config, connection).invoke(kind, input)
}

/**
 * Whether the deployment has the credential MCP needs, without a network call.
 *
 * @param {any} ctx - registrant context.
 * @param {Record<string, unknown> | undefined} config - the Loader row config.
 * @param {any} connection - resolved connection.
 * @returns {Promise<boolean>} true when an MCP call can be attempted.
 */
async function hasMcpCredential(ctx, config, connection) {
  if (connection.deployment === 'cloud') {
    const record = await readOAuthRecord(ctx)
    return Boolean(record?.access_token)
  }
  const key = await resolveCredential(ctx, KEY_REF, str(config?.apiKey))
  return Boolean(key)
}

/**
 * Resolve the workspace slug the web application addresses: the configured slug
 * first, then the workspace the MCP grant covers.
 *
 * @param {any} ctx - registrant context.
 * @param {Record<string, unknown> | undefined} config - the Loader row config.
 * @param {any} connection - resolved connection.
 * @returns {Promise<string | undefined>} the slug, when it is known.
 */
async function resolveWorkspaceSlug(ctx, config, connection) {
  const explicit = str(config?.workspace) ?? (await resolveCredential(ctx, WORKSPACE_REF))?.value
  if (explicit) return explicit
  if (connection.mode !== 'mcp') return undefined

  const cacheKey = `${connection.webBase}|${connection.deployment}`
  const cached = stateFor(ctx).workspaces.get(cacheKey)
  if (cached) return cached
  if (!(await hasMcpCredential(ctx, config, connection))) return undefined

  const result = await mcpInvoke(ctx, config, connection, 'workspaces', {})
  if (!result.ok) return undefined
  const items = Array.isArray(result.data?.items) ? result.data.items : []
  const chosen = items.find((entry) => entry && entry.entireWorkspace === true) ?? items[0]
  const slug = str(chosen?.slug)
  if (slug) stateFor(ctx).workspaces.set(cacheKey, slug)
  return slug
}

/**
 * Build the deep link the DocsMint web application serves, which is
 * `<origin>/w/<workspace-slug>/documents/<id>`.
 *
 * @param {any} ctx - registrant context.
 * @param {Record<string, unknown> | undefined} config - the Loader row config.
 * @param {any} connection - resolved connection.
 * @param {string} [id] - document id.
 * @returns {Promise<string>} the link, or the application origin when the slug is unknown.
 */
async function documentLink(ctx, config, connection, id) {
  const slug = await resolveWorkspaceSlug(ctx, config, connection)
  if (!id || !slug) return connection.webBase
  return `${connection.webBase}/w/${encodeURIComponent(slug)}/documents/${encodeURIComponent(id)}`
}

/**
 * @param {any} ctx - registrant context.
 * @param {Record<string, unknown> | undefined} config - the Loader row config.
 * @param {any} connection - resolved connection.
 * @param {any} data - document response body.
 * @returns {Promise<any>} a normalized document with a working deep link.
 */
function trustedDocumentUrl(data, webBase) {
  const doc = data?.document && typeof data.document === 'object' ? data.document : data
  if (!str(doc?.url)) return undefined
  try {
    const url = new URL(doc.url, webBase)
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== new URL(webBase).origin || url.username || url.password) return undefined
    return url.href
  } catch { return undefined }
}
async function normalizeWithLink(ctx, config, connection, data) {
  const doc = data?.document && typeof data.document === 'object' ? data.document : data
  const explicit = trustedDocumentUrl(data, connection.webBase)
  const slug = str(doc?.workspaceSlug) ?? (explicit || connection.deployment !== 'cloud' ? undefined : await resolveWorkspaceSlug(ctx, config, connection))
  return normalizeDocument(data, connection.webBase, slug, connection.deployment)
}

/**
 * Describe the MCP side of the connection for the panel, without a network call.
 *
 * @param {any} ctx - registrant context.
 * @param {Record<string, unknown> | undefined} config - the Loader row config.
 * @param {any} connection - resolved connection.
 * @returns {Promise<any>} panel-facing MCP state.
 */
async function mcpState(ctx, config, connection) {
  const endpoint = `${connection.webBase}/mcp`
  const session = stateFor(ctx).sessions.get(`${endpoint}|${connection.deployment}`)
  const info = session && typeof session.info === 'function' ? session.info() : { tools: null, server: null }
  if (connection.deployment === 'cloud') {
    const record = await readOAuthRecord(ctx)
    return {
      endpoint,
      transport: 'oauth',
      connected: Boolean(record?.access_token),
      needsConnect: !record?.access_token,
      expiresAt: typeof record?.expires_at === 'number' ? record.expires_at : null,
      tools: info.tools,
      server: info.server,
    }
  }
  const key = await resolveCredential(ctx, KEY_REF, str(config?.apiKey))
  return {
    endpoint,
    transport: 'bearer',
    connected: Boolean(key),
    needsConnect: !key,
    expiresAt: null,
    tools: info.tools,
    server: info.server,
  }
}

/**
 * @param {any} ctx - registrant context.
 * @param {Record<string, unknown> | undefined} config - the Loader row config.
 * @param {{ limit?: unknown, page?: unknown, folderId?: unknown, workspaceId?: unknown }} [options] - paging and filters.
 * @returns {Promise<any>} the list outcome on the active transport.
 */
async function runList(ctx, config, options = {}) {
  const connection = await resolveConnection(ctx, config)
  const filters = compact({
    folderId: str(options.folderId),
    workspaceId: str(options.workspaceId),
    categoryId: options.categoryId,
    sortBy: options.sortBy,
    sortOrder: options.sortOrder,
    q: options.q,
    rootOnly: options.rootOnly,
    tag: options.tag,
    tagIds: options.tagIds,
    tagMatch: options.tagMatch,
    updatedFrom: options.updatedFrom,
    updatedTo: options.updatedTo,
  })
  if (connection.mode !== 'mcp') return listDocuments(ctx, config, { ...options, ...filters })
  return mcpInvoke(ctx, config, connection, 'list', {
    limit: options.limit,
    page: options.page,
    ...filters,
  })
}

/**
 * @param {any} ctx - registrant context.
 * @param {Record<string, unknown> | undefined} config - the Loader row config.
 * @param {{ query?: unknown, limit?: unknown, signal?: AbortSignal }} [options] - search input.
 * @returns {Promise<any>} the search outcome on the active transport.
 */
async function runSearch(ctx, config, options = {}) {
  const connection = await resolveConnection(ctx, config)
  if (connection.mode !== 'mcp') return searchDocuments(ctx, config, options)
  const query = str(options.query)
  if (!query) return failure('empty-query', 'Search text is required.', 400)
  return mcpInvoke(ctx, config, connection, 'search', { query, limit: options.limit, workspaceId: str(options.workspaceId), categoryId: str(options.categoryId) })
}

/**
 * @param {any} ctx - registrant context.
 * @param {Record<string, unknown> | undefined} config - the Loader row config.
 * @param {{ id?: unknown, signal?: AbortSignal }} [options] - document id.
 * @returns {Promise<any>} the read outcome on the active transport.
 */
async function runRead(ctx, config, options = {}) {
  const connection = await resolveConnection(ctx, config)
  if (connection.mode !== 'mcp') return readDocument(ctx, config, options)
  const id = str(options.id)
  if (!id) return failure('missing-id', 'A DocsMint document id is required.', 400)
  return mcpInvoke(ctx, config, connection, 'get', { id })
}

/**
 * @param {any} ctx - registrant context.
 * @param {Record<string, unknown> | undefined} config - the Loader row config.
 * @param {{ title?: unknown, content?: unknown, folderId?: unknown, signal?: AbortSignal }} [options] - new document.
 * @returns {Promise<any>} the create outcome on the active transport.
 */
async function runCreate(ctx, config, options = {}) {
  const connection = await resolveConnection(ctx, config)
  if (connection.mode !== 'mcp') return createDocument(ctx, config, options)
  const title = str(options.title)
  if (!title) return failure('missing-title', 'A document title is required.', 400)
  return mcpInvoke(ctx, config, connection, 'create', {
    title,
    content: typeof options.content === 'string' ? options.content : '',
    folderId: str(options.folderId),
    workspaceId: str(options.workspaceId),
    categoryId: str(options.categoryId),
  })
}

/**
 * Update a document's title and Markdown body.
 *
 * @param {any} ctx - registrant context.
 * @param {Record<string, unknown> | undefined} config - the Loader row config.
 * @param {{ id?: unknown, title?: unknown, content?: unknown, signal?: AbortSignal }} [options] - the edit.
 * @returns {Promise<any>} the update outcome on the active transport.
 */
async function runUpdate(ctx, config, options = {}) {
  const connection = await resolveConnection(ctx, config)
  const id = str(options.id)
  if (!id) return failure('missing-id', 'A DocsMint document id is required.', 400)
  /** @type {Record<string, unknown>} */
  const body = {}
  const title = str(options.title)
  if (title) body.title = title
  if (typeof options.content === 'string') body.content = options.content
  if (Object.keys(body).length === 0) return failure('empty-update', 'Nothing to update.', 400)

  if (connection.mode !== 'mcp') {
    return docsmintRequest(ctx, config, `/documents/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body,
      signal: options.signal,
    })
  }
  return mcpInvoke(ctx, config, connection, 'update', { id, title: body.title, content: body.content })
}

/**
 * List the workspace structure the filters need: workspaces, folders or
 * categories.
 *
 * @param {any} ctx - registrant context.
 * @param {Record<string, unknown> | undefined} config - the Loader row config.
 * @param {'workspaces' | 'folders' | 'categories'} kind - structure kind.
 * @returns {Promise<any>} `{ ok: true, items }` or a failure.
 */
async function runStructure(ctx, config, kind) {
  const connection = await resolveConnection(ctx, config)
  /** @type {Record<string, string>} */
  const restPaths = { workspaces: '', folders: '/folders', categories: '/categories' }
  if (connection.mode !== 'mcp') {
    const path = restPaths[kind]
    if (!path) {
      return failure('structure-unsupported', 'Listing workspaces needs the MCP transport.', 400)
    }
    const result = await docsmintRequest(ctx, config, path)
    if (!result.ok) return result
    const items = Array.isArray(result.data?.items)
      ? result.data.items
      : Array.isArray(result.data)
        ? result.data
        : Array.isArray(result.data?.folders)
          ? result.data.folders
          : Array.isArray(result.data?.categories)
            ? result.data.categories
            : []
    return { ok: true, status: 200, data: { items } }
  }
  return mcpInvoke(ctx, config, connection, kind, {})
}

/**
 * @param {any} ctx - registrant context.
 * @param {Record<string, unknown> | undefined} config - the Loader row config.
 * @param {{ name?: unknown, parentId?: unknown, categoryId?: unknown, workspaceId?: unknown }} options - the folder.
 * @returns {Promise<any>} the create outcome on the active transport.
 */
async function runCreateFolder(ctx, config, options = {}) {
  const connection = await resolveConnection(ctx, config)
  const name = str(options.name)
  if (!name) return failure('missing-name', 'A folder name is required.', 400)
  if (connection.mode !== 'mcp') {
    return docsmintRequest(ctx, config, '/folders', {
      method: 'POST',
      body: compact({ name, parentId: str(options.parentId), categoryId: str(options.categoryId) }),
    })
  }
  return mcpInvoke(ctx, config, connection, 'create-folder', {
    name,
    folderId: str(options.parentId),
    categoryId: str(options.categoryId),
    workspaceId: str(options.workspaceId),
  })
}

/**
 * @param {any} ctx - registrant context.
 * @param {Record<string, unknown> | undefined} config - the Loader row config.
 * @param {{ name?: unknown, workspaceId?: unknown }} options - the category.
 * @returns {Promise<any>} the create outcome on the active transport.
 */
async function runCreateCategory(ctx, config, options = {}) {
  const connection = await resolveConnection(ctx, config)
  const name = str(options.name)
  if (!name) return failure('missing-name', 'A category name is required.', 400)
  if (connection.mode !== 'mcp') {
    return docsmintRequest(ctx, config, '/categories', { method: 'POST', body: { name } })
  }
  return mcpInvoke(ctx, config, connection, 'create-category', {
    name,
    workspaceId: str(options.workspaceId),
  })
}

/**
 * Start the DocsMint Cloud OAuth flow: discover the server's metadata, register
 * a public client for this Host's loopback callback, and hand the browser the
 * authorization URL.
 *
 * @param {any} ctx - registrant context.
 * @param {Record<string, unknown> | undefined} config - the Loader row config.
 * @returns {Promise<any>} `{ ok: true, authorizeUrl, redirectUri }` or a failure.
 */
async function startOAuth(ctx, config) {
  const generation = stateFor(ctx).generation
  const connection = await resolveConnection(ctx, config)
  if (connection.deployment !== 'cloud') {
    return failure(
      'oauth-cloud-only',
      'OAuth is the DocsMint Cloud flow. A self-hosted instance authenticates MCP with its own API key.',
      400,
    )
  }
  const credentials = /** @type {any} */ (ctx.get('credentials'))
  if (!credentials || typeof credentials.set !== 'function') {
    return failure('no-credential-store', 'This profile has no credential store, so the OAuth token cannot be kept.', 409)
  }

  let origin
  try {
    origin = String(ctx.webServer.getOrigin()).replace(/\/+$/, '')
  } catch {
    return failure('no-origin', 'The Web server has not bound its port yet; retry in a moment.', 503)
  }

  const discovery = await discoverAuthorization(connection.webBase)
  if (!discovery.ok) return discovery

  const redirectUri = `${origin}${OAUTH_PATH}`
  const scope = discovery.scopes.length > 0 ? discovery.scopes.join(' ') : undefined
  const registration = await registerOAuthClient(discovery.metadata, { redirectUri, scope })
  if (!registration.ok) return registration

  for (const [key, entry] of stateFor(ctx).pending) {
    if (Date.now() - entry.createdAt > 10 * 60_000) stateFor(ctx).pending.delete(key)
  }

  const state = randomToken(24)
  const { verifier, challenge } = await pkcePair()
  if (!stateFor(ctx).active || stateFor(ctx).generation !== generation) return failure('connection-changed', 'The DocsMint connection changed.', 409)
  stateFor(ctx).pending.set(state, {
    verifier,
    clientId: registration.clientId,
    redirectUri,
    resource: discovery.resource,
    metadata: discovery.metadata,
    tokenEndpoint: str(discovery.metadata.token_endpoint),
    createdAt: Date.now(),
  })

  return {
    ok: true,
    authorizeUrl: authorizationUrl(discovery.metadata, {
      clientId: registration.clientId,
      redirectUri,
      scope,
      resource: discovery.resource,
      state,
      challenge,
    }),
    redirectUri,
    scopes: discovery.scopes,
    resource: discovery.resource,
  }
}

/**
 * @param {any} ctx - registrant context.
 * @returns {Promise<any>} `{ ok: true }` or a failure.
 */
async function disconnectOAuth(ctx) {
  invalidateContext(ctx)
  const credentials = /** @type {any} */ (ctx.get('credentials'))
  if (!credentials || typeof credentials.unset !== 'function') {
    return failure('no-credential-store', 'This profile has no credential store.', 409)
  }
  try {
    await mutateCredentials(ctx, () => credentials.unset(OAUTH_REF))
  } catch (error) {
    return failure('store-failed', `Could not clear the DocsMint OAuth token: ${'The operation failed.'}`, 500)
  }
  stateFor(ctx).sessions.clear()
  return { ok: true }
}

/**
 * @param {unknown} value - text from the authorization server.
 * @returns {string} HTML-escaped text.
 */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * @param {string} title - page heading.
 * @param {string} message - page body.
 * @returns {string} a self-contained page for the OAuth redirect.
 */
function oauthPage(title, message) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
    font:15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    background:#0b1310; color:#e8f5ee; }
  main { max-width:34rem; padding:2.5rem; border-radius:16px;
    border:1px solid #1f3b31; background:#0f1c17; }
  h1 { margin:0 0 .6rem; font-size:1.15rem; }
  p { margin:0; color:#a7c4b7; }
</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main>
<script>setTimeout(function () { try { window.close() } catch (error) {} }, 1500)</script>
</body></html>`
}

/**
 * @param {string} status - HTTP status.
 * @returns {string} a stable machine code for the panel and the tools.
 */
function codeForStatus(status) {
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not-found'
  if (status === 409) return 'conflict'
  if (status === 422) return 'invalid'
  if (status === 429) return 'rate-limited'
  if (status >= 500) return 'upstream'
  return 'http-error'
}

/**
 * @param {number} status - HTTP status.
 * @param {any} data - parsed response body, when it parsed.
 * @param {string} text - raw response body.
 * @returns {string} a message that names the next action.
 */
function describeFailure(status, data, text) {
  const detail = str(data?.error) ?? str(data?.message) ?? str(text)?.slice(0, 300)
  if (status === 401) return 'DocsMint rejected the API key (401). Enter a current key in the DocsMint panel.'
  if (status === 403) return `The DocsMint key is not allowed to do that (403)${detail ? `: ${detail}` : '.'}`
  if (status === 404) return `DocsMint has no such resource in this workspace (404)${detail ? `: ${detail}` : '.'}`
  if (status === 429) return 'DocsMint rate-limited this key (429). Wait a moment and retry.'
  return `DocsMint request failed (${status})${detail ? `: ${detail}` : '.'}`
}

/**
 * @param {string} code - machine code.
 * @param {string} text - human-readable message.
 * @param {number} status - HTTP status, 0 for a transport failure.
 * @returns {{ ok: false, code: string, message: string, status: number }} a failure.
 */
function failure(code, text, status = 0) {
  return { ok: false, code, message: text, status }
}

/**
 * Perform one authenticated DocsMint request.
 *
 * @param {{ get(name: string): unknown }} ctx - registrant context.
 * @param {Record<string, unknown> | undefined} config - the Loader row config.
 * @param {string} path - API path appended to the API base.
 * @param {{ method?: string, body?: unknown, signal?: AbortSignal }} [options] - request options.
 * @returns {Promise<{ ok: true, status: number, data: any } | { ok: false, code: string, message: string, status: number }>} the outcome.
 */
async function docsmintRequest(ctx, config, path, options = {}) {
  const connection = await resolveConnection(ctx, config)
  if (!connection.apiKey) {
    return failure(
      'no-credential',
      'No DocsMint API key is configured. Add one in the DocsMint sidebar panel, or set the DOCSMINT_API_KEY environment variable.',
      401,
    )
  }
  /** @type {Record<string, string>} */
  const headers = { accept: 'application/json', authorization: `Bearer ${connection.apiKey}` }
  if (str(options.workspaceId) ?? connection.workspace) headers['x-docsmint-workspace'] = str(options.workspaceId) ?? connection.workspace
  /** @type {{ method: string, headers: Record<string, string>, signal?: AbortSignal, body?: string }} */
  const init = { method: options.method ?? 'GET', headers, redirect: 'error' }
  if (options.signal) init.signal = options.signal
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json'
    init.body = JSON.stringify(options.body)
  }

  let response
  try {
    if (connection.generation !== stateFor(ctx).generation || !stateFor(ctx).active) return failure('connection-changed', 'The DocsMint connection changed.', 409)
    response = await fetch(connection.apiBase + path, init)
  } catch (error) {
    if (options.signal?.aborted) return failure('aborted', 'The DocsMint request was cancelled.', 0)
    return failure('network', 'Could not reach the configured DocsMint server.', 0)
  }

  let text = ''
  try {
    if (Number(response.headers.get('content-length')) > 1_048_576) { await response.body?.cancel(); return failure('response-too-large', 'The DocsMint response was too large.', 502) }
    const reader = response.body?.getReader()
    const decoder = new TextDecoder()
    let size = 0
    if (reader) while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 1_048_576) { await reader.cancel(); return failure('response-too-large', 'The DocsMint response was too large.', 502) }
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
  } catch { return failure('response-read', 'The DocsMint response could not be read.', 502) }
  if (text.includes(connection.apiKey)) return failure('response-rejected', 'The DocsMint response contained private credentials.', 502)
  /** @type {any} */
  let data
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = undefined
    }
  }
  if (!response.ok) {
    return failure(codeForStatus(response.status), `DocsMint returned HTTP ${response.status}.`, response.status)
  }
  return { ok: true, status: response.status, data: data ?? {} }
}

/**
 * @param {any} data - list response body.
 * @returns {any[]} list items, tolerant of the trimmed list shape.
 */
function listItems(data) {
  const items = Array.isArray(data?.items) ? data.items : Array.isArray(data?.documents) ? data.documents : []
  return items.map((item) =>
    compact({
      id: str(item?.id) ?? '',
      workspaceId: str(item?.workspaceId),
      workspaceSlug: str(item?.workspaceSlug),
      url: str(item?.url),
      title: str(item?.title) ?? 'Untitled document',
      snippet: str(item?.content) ?? str(item?.snippet) ?? '',
      folder: str(item?.folder_name) ?? str(item?.folderName),
      folderId: str(item?.folder_id) ?? str(item?.folderId),
      category: str(item?.category_name) ?? str(item?.categoryName),
      categoryId: str(item?.category_id) ?? str(item?.categoryId),
      updatedAt: str(item?.updated_at) ?? str(item?.updatedAt),
      createdAt: str(item?.created_at) ?? str(item?.createdAt),
      tags: Array.isArray(item?.tags) ? item.tags.map((tag) => str(tag?.name)).filter(Boolean) : [],
    }),
  )
}

/**
 * @param {any} data - search response body.
 * @returns {any[]} normalized search hits.
 */
function searchItems(data) {
  const raw = Array.isArray(data?.items) ? data.items : Array.isArray(data?.results) ? data.results : []
  return raw.map((item) => {
    const chunk = Array.isArray(item?.chunks) ? str(item.chunks[0]?.chunkText) : undefined
    return compact({
      id: str(item?.id) ?? '',
      workspaceId: str(item?.workspaceId),
      workspaceSlug: str(item?.workspaceSlug),
      url: str(item?.url),
      title: str(item?.title) ?? 'Untitled document',
      snippet: str(item?.snippet) ?? chunk ?? '',
      score: Number.isFinite(num(item?.score)) ? Math.round(num(item.score) * 1000) / 1000 : undefined,
      folder: str(item?.folder_name) ?? str(item?.folderName),
      updatedAt: str(item?.updated_at) ?? str(item?.updatedAt),
    })
  })
}

/**
 * @param {any} data - document response body.
 * @param {string} webBase - product origin.
 * @param {string} [slug] - workspace slug the web application addresses.
 * @returns {any} a normalized document.
 */
function normalizeDocument(data, webBase, slug, deployment = 'cloud') {
  const doc = data?.document && typeof data.document === 'object' ? data.document : data
  const id = str(doc?.id) ?? ''
  const content = typeof doc?.content === 'string' ? doc.content : ''
  return compact({
    id,
    workspaceId: str(doc?.workspaceId),
    workspaceSlug: str(doc?.workspaceSlug),
    title: str(doc?.title) ?? 'Untitled document',
    content,
    folder: str(doc?.folder_name) ?? str(doc?.folderName),
    category: str(doc?.category_name) ?? str(doc?.categoryName),
    visibility: str(doc?.visibility),
    updatedAt: str(doc?.updated_at) ?? str(doc?.updatedAt),
    createdAt: str(doc?.created_at) ?? str(doc?.createdAt),
    tags: Array.isArray(doc?.tags) ? doc.tags.map((tag) => str(tag?.name)).filter(Boolean) : [],
    url: trustedDocumentUrl(data, webBase) ?? (id && deployment !== 'cloud' ? `${webBase}/docs/${encodeURIComponent(id)}` : id && slug ? `${webBase}/w/${encodeURIComponent(slug)}/documents/${encodeURIComponent(id)}` : webBase),
  })
}

/**
 * @param {any} ctx - registrant context.
 * @param {Record<string, unknown> | undefined} config - the Loader row config.
 * @param {{ limit?: unknown, page?: unknown, folderId?: unknown, workspaceId?: unknown }} [options] - paging and filters.
 * @returns {Promise<any>} the list outcome.
 */
async function listDocuments(ctx, config, options = {}) {
  const limit = clampInt(options.limit, 1, 50, defaultPageSize(config))
  const page = clampInt(options.page, 1, 1000, 1)
  const params = new URLSearchParams({ page: String(page), limit: String(limit) })
  const folderId = str(options.folderId)
  if (folderId) params.set('folderId', folderId)
  const workspaceId = str(options.workspaceId)
  if (workspaceId) params.set('workspaceId', workspaceId)
  for (const name of ['categoryId', 'sortBy', 'sortOrder', 'q', 'rootOnly', 'tag', 'tagIds', 'tagMatch', 'updatedFrom', 'updatedTo']) {
    const value = options[name]
    if (value !== undefined && value !== null) params.set(name, Array.isArray(value) ? value.join(',') : String(value))
  }
  return docsmintRequest(ctx, config, `/documents?${params.toString()}`)
}

/**
 * @param {any} ctx - registrant context.
 * @param {Record<string, unknown> | undefined} config - the Loader row config.
 * @param {{ query?: unknown, limit?: unknown, signal?: AbortSignal }} [options] - search input.
 * @returns {Promise<any>} the search outcome.
 */
async function searchDocuments(ctx, config, options = {}) {
  const query = str(options.query)
  if (!query) return failure('empty-query', 'Search text is required.', 400)
  const limit = clampInt(options.limit, 1, 50, 10)
  const params = new URLSearchParams({ q: query, page: '1', limit: String(limit), includeChunks: 'true' })
  if (str(options.categoryId)) params.set('category', str(options.categoryId))
  return docsmintRequest(ctx, config, `/search?${params.toString()}`, { signal: options.signal, workspaceId: str(options.workspaceId) })
}

/**
 * @param {any} ctx - registrant context.
 * @param {Record<string, unknown> | undefined} config - the Loader row config.
 * @param {{ id?: unknown, signal?: AbortSignal }} [options] - document id.
 * @returns {Promise<any>} the read outcome.
 */
async function readDocument(ctx, config, options = {}) {
  const id = str(options.id)
  if (!id) return failure('missing-id', 'A DocsMint document id is required.', 400)
  return docsmintRequest(ctx, config, `/documents/${encodeURIComponent(id)}`, { signal: options.signal })
}

/**
 * @param {any} ctx - registrant context.
 * @param {Record<string, unknown> | undefined} config - the Loader row config.
 * @param {{ title?: unknown, content?: unknown, folderId?: unknown, signal?: AbortSignal }} [options] - new document.
 * @returns {Promise<any>} the create outcome.
 */
async function createDocument(ctx, config, options = {}) {
  const title = str(options.title)
  if (!title) return failure('missing-title', 'A document title is required.', 400)
  /** @type {Record<string, unknown>} */
  const body = { title, content: typeof options.content === 'string' ? options.content : '' }
  const folderId = str(options.folderId)
  if (folderId) body.folderId = folderId
  if (str(options.categoryId)) body.categoryId = str(options.categoryId)
  return docsmintRequest(ctx, config, '/documents', { method: 'POST', body, signal: options.signal, workspaceId: str(options.workspaceId) })
}

/**
 * Describe the current connection for the panel, without exposing the key.
 *
 * @param {any} ctx - registrant context.
 * @param {Record<string, unknown> | undefined} config - the Loader row config.
 * @returns {Promise<any>} panel-facing connection state.
 */
async function connectionState(ctx, config) {
  const connection = await resolveConnection(ctx, config)
  const mcp = connection.mode === 'mcp' ? await mcpState(ctx, config, connection) : null
  const slug = await resolveWorkspaceSlug(ctx, config, connection)
  const state = {
    ok: true,
    mode: connection.mode,
    modeSource: connection.modeSource,
    modeLocked: connection.modeLocked,
    configured: connection.mode === 'mcp' ? Boolean(mcp?.connected) : Boolean(connection.apiKey),
    deployment: connection.deployment,
    apiBase: connection.apiBase,
    webBase: connection.webBase,
    webHome: slug ? `${connection.webBase}/w/${encodeURIComponent(slug)}` : connection.webBase,
    workspaceSlug: slug ?? null,
    endpointSource: connection.endpointSource,
    endpointLocked: connection.endpointLocked,
    workspace: connection.workspace ?? '',
    keySource: connection.keySource ?? null,
    workspaceSource: connection.workspaceSource ?? null,
    mcp,
    tools: TOOL_NAMES,
    canStoreCredentials: Boolean(/** @type {any} */ (ctx.get('credentials'))),
  }
  if (connection.endpointWarning) state.note = connection.endpointWarning
  return state
}

/**
 * Store a key, workspace slug, deployment choice or connection type.
 *
 * @param {any} ctx - registrant context.
 * @param {Record<string, unknown> | undefined} config - the Loader row config.
 * @param {{ apiKey?: unknown, workspace?: unknown, deployment?: unknown, baseUrl?: unknown, mode?: unknown }} params - panel input.
 * @returns {Promise<any>} the new connection state, or a failure.
 */
async function saveConnection(ctx, config, params = {}) {
  invalidateContext(ctx)
  const credentials = /** @type {any} */ (ctx.get('credentials'))
  if (!credentials || typeof credentials.set !== 'function') {
    return failure(
      'no-credential-store',
      'This profile has no credential store. Set DOCSMINT_API_KEY in the environment, or config.apiKey in config/cordis.patch.yml.',
      409,
    )
  }

  /** @type {string | undefined} */
  let endpoint
  if (typeof params.deployment === 'string') {
    if (params.deployment === 'cloud') {
      endpoint = 'cloud'
    } else if (params.deployment === 'self-hosted') {
      endpoint = normalizeApiBase(params.baseUrl)
      if (!endpoint) {
        return failure(
          'invalid-endpoint',
          'Enter the self-hosted instance URL, for example http://localhost:50700.',
          400,
        )
      }
    } else {
      return failure('invalid-deployment', `Unknown deployment "${params.deployment}".`, 400)
    }
  }

  /** @type {string | undefined} */
  let mode
  if (typeof params.mode === 'string') {
    if (params.mode === 'api' || params.mode === 'mcp') mode = params.mode
    else return failure('invalid-mode', `Unknown connection type "${params.mode}".`, 400)
  }

  const profileState = stateFor(ctx)
  const generation = profileState.generation
  const changes = []
  if (typeof params.apiKey === 'string') changes.push([KEY_REF, params.apiKey.trim() || undefined])
  if (typeof params.workspace === 'string') changes.push([WORKSPACE_REF, params.workspace.trim() || undefined])
  if (endpoint) changes.push([ENDPOINT_REF, endpoint])
  if (mode) changes.push([MODE_REF, mode])
  try {
    await mutateCredentials(ctx, async () => {
      profileState.blocked = true
      const previous = new Map()
      const touched = []
      const current = () => profileState.active && profileState.generation === generation
      if (!current()) throw new Error('connection-changed')
      for (const [ref] of changes) previous.set(ref, (await credentials.resolve(ref))?.value)
      try {
        for (const [ref, value] of changes) {
          if (!current()) throw new Error('connection-changed')
          touched.push(ref)
          if (value) await credentials.set(ref, value)
          else await credentials.unset(ref)
          if (!current()) throw new Error('connection-changed')
        }
        profileState.blocked = false
      } catch (error) {
        let rollbackFailed = false
        for (const ref of touched.reverse()) {
          try {
            const value = previous.get(ref)
            if (value) await credentials.set(ref, value)
            else await credentials.unset(ref)
          } catch { rollbackFailed = true }
        }
        if (rollbackFailed) {
          // A damaged store must not retain a usable key paired with a partially
          // updated endpoint. Fail closed instead of trying the mixed profile.
          try { await credentials.unset(KEY_REF) } catch {}
        }
        throw error
      }
    })
  } catch {
    return failure('store-failed', 'Could not store the DocsMint connection.', 500)
  }

  const state = await connectionState(ctx, config)
  if (state.endpointLocked && endpoint) {
    state.note = `The endpoint is pinned by the bundle patch (${state.apiBase}). Edit config.baseUrl to change it.`
  } else if (state.modeLocked && mode) {
    state.note = `The connection type is pinned by the bundle patch (${state.mode}). Edit config.mode to change it.`
  }
  return state
}

/**
 * @param {unknown} args - model-supplied tool arguments.
 * @returns {Record<string, any>} the argument object.
 */
function toolArgs(args) {
  return args && typeof args === 'object' && !Array.isArray(args) ? /** @type {Record<string, any>} */ (args) : {}
}

/**
 * @param {any} result - an operation outcome.
 * @returns {never} always throws, carrying the API's own message.
 */
function throwFailure(result) {
  const suffix = result.status ? ` (HTTP ${result.status})` : ''
  throw new Error(`${result.message}${suffix}`)
}

/**
 * Build the model-facing tool definitions. Each one calls the same operation the
 * panel calls, so a fix or a behaviour change applies to both callers.
 *
 * @param {any} ctx - registrant context.
 * @param {Record<string, unknown> | undefined} config - the Loader row config.
 * @returns {any[]} tool definitions.
 */
function toolDefinitions(ctx, config) {
  return [
    {
      name: 'docsmint_search',
      description:
        'Search the user\'s DocsMint workspace (hosted docsmint.com or a self-hosted instance) by wording and meaning, using the same hybrid search the product uses. Returns document ids, titles, snippets and scores. Follow up with docsmint_get_document to read a hit.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'What to look for, in natural language or keywords.' },
          limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum hits to return; defaults to 10.' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['query', 'total', 'results'],
          properties: {
            query: { type: 'string' },
            totalIsGlobal: { type: 'boolean' },
            pagination: { type: 'string' },
            total: { type: 'integer' },
            results: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'title', 'snippet'],
                properties: {
                  id: { type: 'string' },
                  title: { type: 'string' },
                  snippet: { type: 'string' },
                  workspaceId: { type: 'string' },
                  workspaceSlug: { type: 'string' },
                  url: { type: 'string' },
                  score: { type: 'number' },
                  folder: { type: 'string' },
                  updatedAt: { type: 'string' },
                },
              },
            },
          },
        },
        render: (_args, value) => {
          const results = Array.isArray(value?.results) ? value.results : []
          if (results.length === 0) return [{ type: 'text', text: `No DocsMint documents matched "${value?.query ?? ''}".` }]
          const lines = results.map((hit, index) => {
            const meta = [hit.folder, hit.updatedAt].filter(Boolean).join(' · ')
            return `${index + 1}. ${hit.title} — ${hit.id}${meta ? ` (${meta})` : ''}\n   ${hit.snippet}`
          })
          return [{ type: 'text', text: `DocsMint search for "${value?.query ?? ''}" (${value?.total ?? results.length} matches):\n${lines.join('\n')}` }]
        },
      },
      presentCall: (args) => ({ card: 'generic', title: `Search DocsMint: ${str(args?.query) ?? ''}`, kind: 'search', rawInput: args }),
      async execute(args, exec) {
        const input = toolArgs(args)
        const result = await runSearch(ctx, config, { query: input.query, limit: input.limit, signal: exec?.signal })
        if (!result.ok) throwFailure(result)
        const results = searchItems(result.data)
        return {
          query: str(input.query) ?? '',
          ...(result.data?.scopedResults ? { pagination: 'per-scope', totalIsGlobal: false } : {}),
          total: Number.isFinite(num(result.data?.total)) ? result.data.total : results.length,
          results,
        }
      },
    },
    {
      name: 'docsmint_get_document',
      description:
        'Read one DocsMint document by id, including its full Markdown content, folder, category, tags and a link to open it in the DocsMint web app.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['id'],
        properties: {
          id: { type: 'string', description: 'Document id from docsmint_search.' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'title', 'content', 'url'],
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            content: { type: 'string' },
            url: { type: 'string' },
            folder: { type: 'string' },
            category: { type: 'string' },
            visibility: { type: 'string' },
            updatedAt: { type: 'string' },
            createdAt: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
          },
        },
        render: (_args, value) => {
          const meta = [value?.folder, value?.category, value?.updatedAt].filter(Boolean).join(' · ')
          const head = `# ${value?.title ?? 'Document'}\n${meta}${meta ? '\n' : ''}${value?.url ?? ''}`
          return [{ type: 'text', text: `${head}\n\n${value?.content ?? ''}` }]
        },
      },
      presentCall: (args) => ({ card: 'generic', title: `Read DocsMint document ${str(args?.id) ?? ''}`, kind: 'read', rawInput: args }),
      async execute(args, exec) {
        const input = toolArgs(args)
        const result = await runRead(ctx, config, { id: input.id, signal: exec?.signal })
        if (!result.ok) throwFailure(result)
        return await normalizeWithLink(ctx, config, await resolveConnection(ctx, config), result.data)
      },
    },
    {
      name: 'docsmint_create_document',
      description:
        'Create a DocsMint document in the user\'s workspace from Markdown content. Returns the new document id and its link. Use it when the user asks to save findings into DocsMint.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'content'],
        properties: {
          title: { type: 'string', description: 'Document title.' },
          content: { type: 'string', description: 'Markdown body of the new document.' },
          folderId: { type: 'string', description: 'Optional DocsMint folder id to place the document in.' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'title', 'url'],
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            url: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: `Created DocsMint document "${value?.title ?? ''}" (${value?.id ?? ''}) at ${value?.url ?? ''}.` }],
      },
      presentCall: (args) => ({ card: 'generic', title: `Create DocsMint document: ${str(args?.title) ?? ''}`, kind: 'edit', rawInput: args }),
      async execute(args, exec) {
        const input = toolArgs(args)
        const result = await runCreate(ctx, config, {
          title: input.title,
          content: input.content,
          folderId: input.folderId,
          signal: exec?.signal,
        })
        if (!result.ok) throwFailure(result)
        const document = await normalizeWithLink(ctx, config, await resolveConnection(ctx, config), result.data)
        return { id: document.id, title: document.title, url: document.url }
      },
    },
    {
      name: 'docsmint_update_document',
      description:
        'Update the title and/or Markdown body of an existing DocsMint document. Returns the stored document. Use it when the user asks to fix, extend or retitle a DocsMint document.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['id'],
        properties: {
          id: { type: 'string', description: 'Document id from docsmint_search.' },
          title: { type: 'string', description: 'New title; omit to keep the current one.' },
          content: { type: 'string', description: 'New Markdown body; omit to keep the current one.' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'title', 'content', 'url'],
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            content: { type: 'string' },
            url: { type: 'string' },
            folder: { type: 'string' },
            category: { type: 'string' },
            visibility: { type: 'string' },
            updatedAt: { type: 'string' },
            createdAt: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
          },
        },
        render: (_args, value) => [
          { type: 'text', text: `Updated DocsMint document "${value?.title ?? ''}" (${value?.id ?? ''}) at ${value?.url ?? ''}.` },
        ],
      },
      presentCall: (args) => ({ card: 'generic', title: `Update DocsMint document ${str(args?.id) ?? ''}`, kind: 'edit', rawInput: args }),
      async execute(args, exec) {
        const input = toolArgs(args)
        const result = await runUpdate(ctx, config, {
          id: input.id,
          title: input.title,
          content: input.content,
          signal: exec?.signal,
        })
        if (!result.ok) throwFailure(result)
        return await normalizeWithLink(ctx, config, await resolveConnection(ctx, config), result.data)
      },
    },
  ]
}

/**
 * @param {unknown} request - parsed JSON body from the panel.
 * @returns {{ ok: true, method: string, params: Record<string, any> } | { ok: false, code: string, message: string }} the call.
 */
function readRpcCall(request) {
  if (!request || typeof request !== 'object') return { ok: false, code: 'bad-request', message: 'Expected a JSON object body.' }
  const method = str(/** @type {any} */ (request).method)
  if (!method) return { ok: false, code: 'bad-request', message: 'Missing `method`.' }
  const params = /** @type {any} */ (request).params
  return { ok: true, method, params: params && typeof params === 'object' ? params : {} }
}

/**
 * Read a request body with a hard size cap.
 *
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {Promise<string>} the UTF-8 body.
 */
async function readBody(req) {
  const limit = 1_000_000
  /** @type {Buffer[]} */
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > limit) throw new Error('Request body is too large.')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {number} status - HTTP status.
 * @param {unknown} value - JSON body.
 * @returns {void}
 */
function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(body)),
  })
  res.end(body)
}

/**
 * Register the DocsMint bridge: agent tools and the panel's same-origin route.
 *
 * @param {any} ctx - registrant context.
 * @param {Record<string, unknown>} [config] - the Loader row config.
 */
export function apply(ctx, config) {
  const state = stateFor(ctx)
  state.active = true
  ctx.effect(() => () => invalidateContext(ctx, true), 'docsmint:connection-state')
  for (const definition of toolDefinitions(ctx, config)) {
    ctx.effect(() => ctx.tools.register(definition), `docsmint:${definition.name}`)
  }

  const handleRpc = async (req, res) => {
    const connection = /** @type {any} */ (ctx.get('connection'))
    if (!connection || typeof connection.requestRejection !== 'function') {
      sendJson(res, 503, { ok: false, code: 'authorization-unavailable', message: 'The Host authorization service is unavailable.' })
      return
    }
    if (connection && typeof connection.requestRejection === 'function') {
      let rejection
      try {
        rejection = connection.requestRejection({ headers: req.headers })
      } catch {
        rejection = 401
      }
      if (rejection) {
        sendJson(res, rejection, { ok: false, code: 'unauthorized', message: 'This page is not authorized to reach DocsMint.' })
        return
      }
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, code: 'method-not-allowed', message: 'Use POST.' })
      return
    }

    let request
    try {
      request = JSON.parse(await readBody(req))
    } catch (error) {
      sendJson(res, 400, { ok: false, code: 'bad-request', message: 'The operation failed.' })
      return
    }

    const call = readRpcCall(request)
    if (!call.ok) {
      sendJson(res, 400, call)
      return
    }

    try {
      switch (call.method) {
        case 'state':
          sendJson(res, 200, await connectionState(ctx, config))
          return
        case 'save':
          sendJson(res, 200, await saveConnection(ctx, config, call.params))
          return
        case 'list': {
          const result = await runList(ctx, config, {
            limit: call.params.limit,
            page: call.params.page,
            folderId: call.params.folderId,
            workspaceId: call.params.workspaceId,
            categoryId: call.params.categoryId,
            sortBy: call.params.sortBy,
            sortOrder: call.params.sortOrder,
            q: call.params.q,
            rootOnly: call.params.rootOnly,
            tag: call.params.tag,
            tagIds: call.params.tagIds,
            tagMatch: call.params.tagMatch,
            updatedFrom: call.params.updatedFrom,
            updatedTo: call.params.updatedTo,
          })
          if (!result.ok) {
            sendJson(res, 200, result)
            return
          }
          const items = listItems(result.data)
          sendJson(res, 200, {
            ok: true,
            items,
            ...(result.data?.scopedResults ? { scopedResults: result.data.scopedResults, pagination: 'per-scope', totalIsGlobal: false } : {}),
            total: Number.isFinite(num(result.data?.total)) ? result.data.total : items.length,
            page: Number.isFinite(num(result.data?.page)) ? result.data.page : 1,
          })
          return
        }
        case 'structure': {
          const kind = str(call.params.kind)
          if (kind !== 'workspaces' && kind !== 'folders' && kind !== 'categories') {
            sendJson(res, 400, { ok: false, code: 'invalid-kind', message: 'kind must be workspaces, folders or categories.' })
            return
          }
          const result = await runStructure(ctx, config, kind)
          if (!result.ok) {
            sendJson(res, 200, result)
            return
          }
          const rows = Array.isArray(result.data?.items) ? result.data.items : []
          sendJson(res, 200, {
            ok: true,
            items: rows.map((row) =>
              compact({
                id: str(row?.id) ?? '',
                name: str(row?.name) ?? str(row?.title) ?? '',
                slug: str(row?.slug),
                parentId: str(row?.parentId) ?? str(row?.parent_id),
                categoryId: str(row?.categoryId) ?? str(row?.category_id),
                entireWorkspace: row?.entireWorkspace === true ? true : undefined,
              }),
            ),
          })
          return
        }
        case 'update': {
          const result = await runUpdate(ctx, config, {
            id: call.params.id,
            title: call.params.title,
            content: call.params.content,
          })
          if (!result.ok) {
            sendJson(res, 200, result)
            return
          }
          sendJson(res, 200, {
            ok: true,
            document: await normalizeWithLink(ctx, config, await resolveConnection(ctx, config), result.data),
          })
          return
        }
        case 'createFolder': {
          const result = await runCreateFolder(ctx, config, {
            name: call.params.name,
            parentId: call.params.parentId,
            categoryId: call.params.categoryId,
            workspaceId: call.params.workspaceId,
          })
          if (!result.ok) {
            sendJson(res, 200, result)
            return
          }
          const data = result.data ?? {}
          sendJson(res, 200, { ok: true, folder: compact({ id: str(data.id), name: str(data.name), categoryId: str(data.categoryId), parentId: str(data.parentId) }) })
          return
        }
        case 'createCategory': {
          const result = await runCreateCategory(ctx, config, {
            name: call.params.name,
            workspaceId: call.params.workspaceId,
          })
          if (!result.ok) {
            sendJson(res, 200, result)
            return
          }
          const data = result.data ?? {}
          sendJson(res, 200, { ok: true, category: compact({ id: str(data.id), name: str(data.name) }) })
          return
        }
        case 'search': {
          const result = await runSearch(ctx, config, { query: call.params.query, limit: call.params.limit, workspaceId: call.params.workspaceId, categoryId: call.params.categoryId })
          if (!result.ok) {
            sendJson(res, 200, result)
            return
          }
          const items = searchItems(result.data)
          sendJson(res, 200, {
            ok: true,
            items,
            ...(result.data?.scopedResults ? { scopedResults: result.data.scopedResults, pagination: 'per-scope', totalIsGlobal: false } : {}),
            total: Number.isFinite(num(result.data?.total)) ? result.data.total : items.length,
            query: str(call.params.query) ?? '',
          })
          return
        }
        case 'get': {
          const result = await runRead(ctx, config, { id: call.params.id })
          if (!result.ok) {
            sendJson(res, 200, result)
            return
          }
          sendJson(res, 200, { ok: true, document: await normalizeWithLink(ctx, config, await resolveConnection(ctx, config), result.data) })
          return
        }
        case 'create': {
          const result = await runCreate(ctx, config, {
            title: call.params.title,
            content: call.params.content,
            folderId: call.params.folderId,
            workspaceId: call.params.workspaceId,
            categoryId: call.params.categoryId,
          })
          if (!result.ok) {
            sendJson(res, 200, result)
            return
          }
          sendJson(res, 200, {
            ok: true,
            document: await normalizeWithLink(ctx, config, await resolveConnection(ctx, config), result.data),
          })
          return
        }
        case 'mcpConnect':
          sendJson(res, 200, await startOAuth(ctx, config))
          return
        case 'mcpDisconnect': {
          const result = await disconnectOAuth(ctx)
          sendJson(res, 200, result.ok ? await connectionState(ctx, config) : result)
          return
        }
        default:
          sendJson(res, 404, { ok: false, code: 'unknown-method', message: `Unknown method "${call.method}".` })
      }
    } catch (error) {
      sendJson(res, 500, { ok: false, code: 'internal', message: 'The operation failed.' })
    }
  }

  /**
   * The authorization server redirects the browser here, so this route carries
   * no Harness browser credential. It trusts only the single-use `state` nonce
   * an in-flight `mcpConnect` created, and it never accepts a token from the
   * query string.
   *
   * @param {import('node:http').IncomingMessage} req - the redirect request.
   * @param {import('node:http').ServerResponse} res - the response.
   */
  const handleOAuthCallback = async (req, res) => {
    const respond = (status, title, text) => {
      const html = oauthPage(title, text)
      res.writeHead(status, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': String(Buffer.byteLength(html)),
      })
      res.end(html)
    }

    let url
    try {
      url = new URL(String(req.url ?? OAUTH_PATH), 'http://127.0.0.1')
    } catch {
      respond(400, 'DocsMint authorization failed', 'The redirect URL could not be read.')
      return
    }

    const state = str(url.searchParams.get('state')) ?? ''
    const pending = state ? stateFor(ctx).pending.get(state) : undefined
    if (!pending || Date.now() - pending.createdAt > 10 * 60_000) {
      if (state) stateFor(ctx).pending.delete(state)
      respond(400, 'DocsMint authorization expired', 'Start the connection again from the DocsMint panel.')
      return
    }

    if (pending.redirectUri !== `${String(ctx.webServer.getOrigin()).replace(/\/+$/, '')}${OAUTH_PATH}`) {
      stateFor(ctx).pending.delete(state)
      respond(400, 'DocsMint authorization expired', 'The callback origin changed. Start the connection again.')
      return
    }

    const denied = str(url.searchParams.get('error'))
    if (denied) {
      stateFor(ctx).pending.delete(state)
      const description = str(url.searchParams.get('error_description'))
      respond(400, 'DocsMint authorization refused', description ?? denied)
      return
    }

    const code = str(url.searchParams.get('code'))
    if (!code) {
      respond(400, 'DocsMint authorization incomplete', 'The redirect carried no authorization code.')
      return
    }

    stateFor(ctx).pending.delete(state)
    const generation = stateFor(ctx).generation
    const exchanged = await exchangeAuthorizationCode(pending.metadata, {
      clientId: pending.clientId,
      code,
      verifier: pending.verifier,
      redirectUri: pending.redirectUri,
      resource: pending.resource,
    })
    if (!exchanged.ok) {
      respond(502, 'DocsMint token exchange failed', exchanged.message)
      return
    }

    if (!stateFor(ctx).active || stateFor(ctx).generation !== generation) {
      respond(409, 'DocsMint connection changed', 'Start the connection again from the DocsMint panel.')
      return
    }
    try {
      await writeOAuthRecord(ctx, {
        access_token: exchanged.tokens.accessToken,
        refresh_token: exchanged.tokens.refreshToken,
        expires_at: exchanged.tokens.expiresAt,
        scope: exchanged.tokens.scope,
        client_id: pending.clientId,
        token_endpoint: pending.tokenEndpoint,
        resource: pending.resource,
        issued_at: Date.now(),
      })
    } catch (error) {
      respond(500, 'DocsMint token was not stored', 'The operation failed.')
      return
    }

    stateFor(ctx).pending.delete(state)
    stateFor(ctx).sessions.clear()
    respond(200, 'DocsMint connected', 'OAuth is complete. Close this tab and return to the Harness panel.')
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: RPC_PATH, handler: handleRpc }),
    'docsmint:bridge-route',
  )

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: OAUTH_PATH, handler: handleOAuthCallback }),
    'docsmint:oauth-route',
  )
}

export const inject = ['tools', 'webServer']
