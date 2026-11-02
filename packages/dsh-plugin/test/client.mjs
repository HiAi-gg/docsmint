/** Behavioral coverage of the registered panel; this is not browser/layout acceptance. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { test } from 'node:test'

async function mountPanel() {
  const state = [], effects = [], refs = [], calls = []
  let index = 0, dirty = true, tree, Panel, definition, pending = 0
  const dictionaries = new Map()
  const React = {
    createElement(type, props, ...children) { return { type, props: props || {}, children: children.flat(Infinity).filter(x => x !== null && x !== undefined && x !== false) } },
    useState(initial) { const i = index++; if (!(i in state)) state[i] = typeof initial === 'function' ? initial() : initial; return [state[i], value => { state[i] = typeof value === 'function' ? value(state[i]) : value; dirty = true }] },
    useRef(initial) { const i = index++; return refs[i] ||= { current: initial } },
    useEffect(effect, deps) { const i = index++; if (!effects[i] || deps.some((value, n) => !Object.is(value, effects[i].deps[n]))) effects[i] = { deps, effect, pending: true } },
  }
  const fixtures = {
    workspaces: [{ id: 'w1', name: 'First' }, { id: 'w2', name: 'Second' }],
    categories: [{ id: 'c1', name: 'Category one' }, { id: 'c2', name: 'Category two' }],
    folders: [{ id: 'f1', name: 'Folder one', categoryId: 'c1' }],
  }
  const sandbox = {
    window: { __ModuleLoader__: { load(value) { definition = value } } },
    console, setInterval, clearInterval, URL, URLSearchParams,
    fetch: async (url, init) => {
      assert.equal(url, '/docsmint/rpc')
      assert.equal(init.credentials, 'same-origin')
      assert.equal(Object.keys(init.headers).some(key => key.toLowerCase() === 'authorization'), false)
      const call = JSON.parse(init.body); calls.push(call); pending++
      let payload = { ok: true }
      if (call.method === 'state') payload = { ...payload, configured: true, mode: 'mcp', deployment: 'cloud', webHome: 'https://docsmint.com' }
      else if (call.method === 'structure') payload.items = fixtures[call.params.kind] || []
      else if (call.method === 'list') payload = { ...payload, total: 140, items: [
        { id: 'z', title: 'Server first Z', categoryId: 'other-category' },
        { id: 'a', title: 'Server second A', categoryId: 'other-category' },
      ] }
      else if (call.method === 'create') payload.document = { id: 'created', title: call.params.title, content: call.params.content }
      else if (!['createCategory', 'createFolder'].includes(call.method)) throw Error('Unexpected bridge call: ' + call.method)
      await Promise.resolve(); pending--
      return { status: 200, json: async () => payload }
    },
  }
  vm.runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), sandbox, { filename: 'client.js' })
  assert.equal(definition.id, '@hiai-gg/dsh-docsmint')
  const plugin = definition.factory(name => { assert.equal(name, 'react'); return React })
  plugin.apply({
    effect(fn) { fn() },
    locale: { register(namespace, language, entries) { dictionaries.set(language, entries) }, bind() { return key => dictionaries.get('en')[key] || key } },
    slots: { inject(name, register) { register() }, register(options, component) { if (options.name === 'main') Panel = component } },
  })
  assert.equal(typeof Panel, 'function', 'the actual main-slot component is captured')
  function nodes(node = tree) { if (!node || typeof node !== 'object') return []; return [node, ...node.children.flatMap(child => nodes(child))] }
  function text(node) { return typeof node === 'string' || typeof node === 'number' ? String(node) : (node?.children || []).map(text).join('') }
  async function settle() {
    for (let turn = 0; turn < 40; turn++) {
      if (dirty) { dirty = false; index = 0; tree = Panel(); for (const effect of effects) if (effect?.pending) { effect.pending = false; effect.cleanup = effect.effect() } }
      await new Promise(resolve => setImmediate(resolve))
      if (!dirty && pending === 0) return
    }
    throw Error('Panel did not settle')
  }
  await settle()
  return {
    calls, settle, nodes, text,
    async select(label, value) { const field = nodes().find(node => node.type === 'label' && node.props.className === 'dm-select-field' && text(node.children[0]) === label); assert.ok(field, 'select ' + label); const select = nodes(field).find(node => node.type === 'select'); select.props.onChange({ target: { value } }); await settle() },
    async click(label) { const button = nodes().find(node => node.type === 'button' && text(node) === label); assert.ok(button, 'button ' + label); assert.ok(!button.props.disabled, 'button enabled ' + label); button.props.onClick(); await settle() },
    async create(name) { const input = nodes().find(node => node.type === 'input' && node.props.className.includes('dm-create-input')); assert.ok(input); input.props.onChange({ target: { value: name } }); await settle(); const form = nodes().find(node => node.type === 'form' && node.props.className === 'dm-create-form'); form.props.onSubmit({ preventDefault() {} }); await settle() },
  }
}

const last = (panel, method) => panel.calls.filter(call => call.method === method).at(-1)

test('registered panel sends category/folder and sort to the server, without filtering or sorting the returned page locally', async () => {
  const panel = await mountPanel()
  await panel.select('Workspace', 'w1')
  await panel.select('Category', 'c1')
  await panel.select('Folder', 'f1')
  await panel.select('Sort', 'title')
  assert.deepEqual(last(panel, 'list').params, { limit: 50, workspaceId: 'w1', categoryId: 'c1', folderId: 'f1', sortBy: 'title', sortOrder: 'asc' })
  assert.deepEqual(panel.nodes().filter(node => node.props.className === 'dm-item-title').map(panel.text), ['Server first Z', 'Server second A'])
  assert.equal(panel.nodes().find(node => node.props.className === 'dm-count').children[0], '140')
  await panel.select('Sort', 'created-desc')
  assert.equal(last(panel, 'list').params.sortBy, 'createdAt')
  assert.equal(last(panel, 'list').params.sortOrder, 'desc')
})

test('workspace selection clears stale category and folder before requesting another workspace', async () => {
  const panel = await mountPanel()
  await panel.select('Workspace', 'w1'); await panel.select('Category', 'c1'); await panel.select('Folder', 'f1')
  await panel.select('Workspace', 'w2')
  const params = last(panel, 'list').params
  assert.equal(params.workspaceId, 'w2')
  assert.equal(params.categoryId, undefined, 'old workspace category must not cross into the next workspace')
  assert.equal(params.folderId, undefined)
})

test('create document, category and folder retain the selected workspace and placement', async () => {
  for (const [button, method] of [['+ Document', 'create'], ['+ Category', 'createCategory'], ['+ Folder', 'createFolder']]) {
    const panel = await mountPanel()
    await panel.select('Workspace', 'w1'); await panel.select('Category', 'c1'); await panel.select('Folder', 'f1')
    await panel.click(button); await panel.create('Synthetic title')
    const params = last(panel, method).params
    assert.equal(params.workspaceId, 'w1', method + ' workspace')
    if (method !== 'createCategory') assert.equal(params.categoryId, 'c1', method + ' category')
    if (method === 'create') { assert.equal(params.folderId, 'f1'); assert.equal(params.title, 'Synthetic title') }
  }
})
