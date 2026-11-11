/**
 * DocsMint bundle — Client half.
 *
 * Adds one global sidebar entry (a panel icon beside Plugins and Schedules) and
 * the central panel it opens: connect a workspace, search it, read a document,
 * and jump to it in DocsMint. All network work stays on the Host, behind the
 * `/docsmint/rpc` bridge, so no API key reaches page code.
 */
window.__ModuleLoader__.load({
  id: '@hiai-gg/dsh-docsmint',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    function documentListParams(selection, order) {
      const sorting = order === 'title' ? ['title', 'asc']
        : order === 'updated-asc' ? ['updatedAt', 'asc']
        : order === 'created-desc' ? ['createdAt', 'desc'] : ['updatedAt', 'desc']
      return { limit: PAGE_SIZE, workspaceId: selection.workspaceId || undefined,
        folderId: selection.folderId || undefined, categoryId: selection.categoryId || undefined,
        sortBy: sorting[0], sortOrder: sorting[1] }
    }


    /** Client locale namespace of this bundle. */
    const NS = 'docsmint'
    /** Same-origin route the Host half registers. */
    const RPC_PATH = '/docsmint/rpc'
    /** Fallback product link used before the Host reports its settings. */
    const SITE = 'https://docsmint.com'
    const PAGE_SIZE = 50

    const EN = {
      'panel.title': 'DocsMint',
      'panel.subtitle': 'Your documents and knowledge',
      'panel.connected': 'Connected',
      'panel.notConnected': 'Not connected',
      'panel.refresh': 'Refresh',
      'panel.loadMore': 'Show more',
      'panel.synced': 'Updated',
      'panel.searchPlaceholder': 'Search documents…',
      'panel.search': 'Search',
      'panel.clear': 'Clear',
      'panel.documents': 'Documents',
      'panel.results': 'Search results',
      'panel.emptyList': 'This DocsMint workspace has no documents yet.',
      'panel.emptySearch': 'No document matched that search.',
      'panel.loading': 'Loading…',
      'panel.back': 'Back to list',
      'panel.open': 'Open in DocsMint',
      'panel.openSite': 'Open docsmint.com',
      'panel.openInstance': 'Open instance',
      'panel.instance.cloud': 'DocsMint Cloud',
      'panel.instance.selfHosted': 'Self-hosted',
      'panel.chip.folder': 'Folder',
      'panel.chip.category': 'Category',
      'panel.chip.updated': 'Updated',
      'panel.chip.visibility': 'Visibility',
      'panel.tools': 'Agent tools',
      'panel.emptyDocument': 'This document is empty.',
      'panel.setup.title': 'Connect a DocsMint workspace',
      'panel.setup.body':
        'DocsMint Cloud is the default. Choose a self-hosted instance below if that is where your workspace runs, then paste an API key from that instance and the workspace slug for account-scoped keys. The key is stored in the Harness credential store and used only by this Host.',
      'panel.setup.deployment': 'Where DocsMint runs',
      'panel.setup.cloudHint': 'docsmint.com — hosted workspace',
      'panel.setup.selfHostedHint': 'Your own DocsMint OSS or on-prem install',
      'panel.setup.url': 'Instance URL',
      'panel.setup.urlPlaceholder': 'http://localhost:50700',
      'panel.setup.urlHint': 'The /api/v1 path is added automatically.',
      'panel.setup.urlRequired': 'Enter the instance URL to use a self-hosted DocsMint.',
      'panel.setup.key': 'API key',
      'panel.setup.keyPlaceholder': 'dmp_live_…',
      'panel.setup.workspace': 'Workspace slug',
      'panel.setup.workspacePlaceholder': 'my-workspace',
      'panel.setup.apiBase': 'API base URL',
      'panel.setup.save': 'Save and connect',
      'panel.setup.cancel': 'Cancel',
      'panel.setup.keyRequired': 'An API key is required to connect.',
      'panel.setup.keepKey': 'Leave the key empty to keep the stored one.',
      'panel.setup.endpointLocked': 'The endpoint is set by the plugin config.',
      'panel.setup.noStore':
        'This profile has no credential store, so a key cannot be saved here. Set DOCSMINT_API_KEY in the environment or config.apiKey in the bundle patch instead.',
      'panel.source': 'Key source',
      'panel.setup.mode': 'Connection type',
      'panel.mode.api': 'API',
      'panel.mode.apiHint': 'REST API with an API key',
      'panel.mode.mcp': 'MCP',
      'panel.mode.mcpHint': 'Model Context Protocol server',
      'panel.mcp.oauthTitle': 'Authorize DocsMint Cloud MCP',
      'panel.mcp.oauthBody':
        'Cloud MCP uses the project OAuth flow: the browser opens the DocsMint consent screen, you pick the workspace and permissions, and the Harness keeps the tokens. No API key is needed.',
      'panel.mcp.connect': 'Connect with OAuth',
      'panel.mcp.reconnect': 'Reconnect',
      'panel.mcp.disconnect': 'Disconnect',
      'panel.mcp.waiting': 'Waiting for the browser…',
      'panel.mcp.connected': 'OAuth connected',
      'panel.mcp.expires': 'Token expires',
      'panel.mcp.selfBody':
        'A self-hosted instance authenticates MCP with its own API key. It must serve /mcp over Streamable HTTP: DocsMint OSS ships MCP as the stdio binary docsmint-mcp, so API mode stays the supported path until the instance exposes HTTP MCP.',
      'panel.mcp.endpoint': 'MCP endpoint',
      'panel.mcp.tools': 'Tools discovered',
      'panel.mcp.server': 'Server',
      'panel.mcp.failed': 'OAuth did not finish',
      'panel.mcp.reopen': 'Open the consent page again',
      'panel.mcp.copyLink': 'Copy OAuth link',
      'panel.mcp.copied': 'Link copied',
      'panel.mcp.copyFailed': 'Select the link below and copy it manually.',
      'panel.mcp.consentLink': 'OAuth consent link',
      'panel.mcp.linkHint':
        'If the browser did not open, or the consent tab was lost, copy this link and paste it into a browser tab.',
      'filter.workspace': 'Workspace',
      'filter.category': 'Category',
      'filter.folder': 'Folder',
      'filter.all': 'All',
      'filter.sort': 'Sort',
      'filter.reset': 'Reset filters',
      'filter.newCategory': '+ Category',
      'filter.newFolder': '+ Folder',
      'filter.newDocument': '+ Document',
      'filter.namePlaceholder': 'Name',
      'filter.create': 'Create',
      'filter.categoryNote': 'Category filters apply before pagination.',
      'sort.updatedDesc': 'Updated ↓',
      'sort.updatedAsc': 'Updated ↑',
      'sort.title': 'Title A–Z',
      'sort.createdDesc': 'Created ↓',
      'doc.edit': 'Edit',
      'doc.save': 'Save',
      'doc.saving': 'Saving…',
      'doc.cancel': 'Cancel',
      'doc.titleLabel': 'Title',
      'doc.contentLabel': 'Markdown',
      'doc.saved': 'Saved',
      'doc.created': 'Document created',
    }

    const RU = {
      'panel.title': 'DocsMint',
      'panel.subtitle': 'Документы и знания рабочего пространства',
      'panel.connected': 'Подключено',
      'panel.notConnected': 'Не подключено',
      'panel.refresh': 'Обновить',
      'panel.loadMore': 'Показать ещё',
      'panel.synced': 'Обновлено',
      'panel.searchPlaceholder': 'Поиск по документам…',
      'panel.search': 'Найти',
      'panel.clear': 'Сбросить',
      'panel.documents': 'Документы',
      'panel.results': 'Результаты поиска',
      'panel.emptyList': 'В этом рабочем пространстве пока нет документов.',
      'panel.emptySearch': 'По этому запросу ничего не найдено.',
      'panel.loading': 'Загрузка…',
      'panel.back': 'К списку',
      'panel.open': 'Открыть в DocsMint',
      'panel.openSite': 'Открыть docsmint.com',
      'panel.openInstance': 'Открыть инстанс',
      'panel.instance.cloud': 'DocsMint Cloud',
      'panel.instance.selfHosted': 'Свой сервер',
      'panel.chip.folder': 'Папка',
      'panel.chip.category': 'Категория',
      'panel.chip.updated': 'Обновлён',
      'panel.chip.visibility': 'Доступ',
      'panel.tools': 'Инструменты агента',
      'panel.emptyDocument': 'Документ пуст.',
      'panel.setup.title': 'Подключите рабочее пространство DocsMint',
      'panel.setup.body':
        'По умолчанию используется DocsMint Cloud. Если рабочее пространство живёт на своём сервере, выберите его ниже, затем вставьте API-ключ этого инстанса и slug рабочего пространства, если ключ привязан к аккаунту. Ключ хранится в хранилище учётных данных Harness и используется только на стороне Host.',
      'panel.setup.deployment': 'Где работает DocsMint',
      'panel.setup.cloudHint': 'docsmint.com — облачное рабочее пространство',
      'panel.setup.selfHostedHint': 'Свой DocsMint OSS или on-prem установка',
      'panel.setup.url': 'Адрес инстанса',
      'panel.setup.urlPlaceholder': 'http://localhost:50700',
      'panel.setup.urlHint': 'Путь /api/v1 добавляется автоматически.',
      'panel.setup.urlRequired': 'Укажите адрес инстанса для self-hosted DocsMint.',
      'panel.setup.key': 'API-ключ',
      'panel.setup.keyPlaceholder': 'dmp_live_…',
      'panel.setup.workspace': 'Slug рабочего пространства',
      'panel.setup.workspacePlaceholder': 'my-workspace',
      'panel.setup.apiBase': 'Базовый URL API',
      'panel.setup.save': 'Сохранить и подключить',
      'panel.setup.cancel': 'Отмена',
      'panel.setup.keyRequired': 'Для подключения нужен API-ключ.',
      'panel.setup.keepKey': 'Оставьте поле пустым, чтобы сохранить текущий ключ.',
      'panel.setup.endpointLocked': 'Адрес задан конфигурацией плагина.',
      'panel.setup.noStore':
        'В этом профиле нет хранилища учётных данных, поэтому ключ нельзя сохранить здесь. Задайте DOCSMINT_API_KEY в окружении или config.apiKey в патче бандла.',
      'panel.source': 'Источник ключа',
      'panel.setup.mode': 'Тип подключения',
      'panel.mode.api': 'API',
      'panel.mode.apiHint': 'REST API по API-ключу',
      'panel.mode.mcp': 'MCP',
      'panel.mode.mcpHint': 'Сервер Model Context Protocol',
      'panel.mcp.oauthTitle': 'Авторизация MCP в DocsMint Cloud',
      'panel.mcp.oauthBody':
        'MCP в облаке подключается через OAuth проекта: в браузере откроется экран согласия DocsMint, вы выберете рабочее пространство и разрешения, а Harness сохранит токены. API-ключ не нужен.',
      'panel.mcp.connect': 'Подключить через OAuth',
      'panel.mcp.reconnect': 'Переподключить',
      'panel.mcp.disconnect': 'Отключить',
      'panel.mcp.waiting': 'Ожидаем подтверждение в браузере…',
      'panel.mcp.connected': 'OAuth подключён',
      'panel.mcp.expires': 'Токен истекает',
      'panel.mcp.selfBody':
        'Свой инстанс авторизует MCP собственным API-ключом. Инстанс должен отдавать /mcp по Streamable HTTP: в DocsMint OSS MCP поставляется как stdio-бинарник docsmint-mcp, поэтому пока HTTP MCP не включён, поддерживаемый путь — API.',
      'panel.mcp.endpoint': 'MCP-эндпоинт',
      'panel.mcp.tools': 'Найдено инструментов',
      'panel.mcp.server': 'Сервер',
      'panel.mcp.failed': 'OAuth не завершён',
      'panel.mcp.reopen': 'Открыть экран согласия снова',
      'panel.mcp.copyLink': 'Скопировать ссылку OAuth',
      'panel.mcp.copied': 'Ссылка скопирована',
      'panel.mcp.copyFailed': 'Выделите ссылку ниже и скопируйте вручную.',
      'panel.mcp.consentLink': 'Ссылка для согласия OAuth',
      'panel.mcp.linkHint':
        'Если браузер не открылся или вкладка с согласием потерялась, скопируйте ссылку и откройте её в браузере.',
      'filter.workspace': 'Пространство',
      'filter.category': 'Категория',
      'filter.folder': 'Папка',
      'filter.all': 'Все',
      'filter.sort': 'Сортировка',
      'filter.reset': 'Сбросить фильтры',
      'filter.newCategory': '+ Категория',
      'filter.newFolder': '+ Папка',
      'filter.newDocument': '+ Документ',
      'filter.namePlaceholder': 'Название',
      'filter.create': 'Создать',
      'filter.categoryNote': 'Категории фильтруются до разбиения на страницы.',
      'sort.updatedDesc': 'Обновление ↓',
      'sort.updatedAsc': 'Обновление ↑',
      'sort.title': 'Заголовок А–Я',
      'sort.createdDesc': 'Создание ↓',
      'doc.edit': 'Редактировать',
      'doc.save': 'Сохранить',
      'doc.saving': 'Сохранение…',
      'doc.cancel': 'Отмена',
      'doc.titleLabel': 'Заголовок',
      'doc.contentLabel': 'Markdown',
      'doc.saved': 'Сохранено',
      'doc.created': 'Документ создан',
    }

    const CSS = `
      .dm-more { display:flex; flex-wrap:wrap; gap:10px; margin:14px 0; }
      .dm-panel, .dm-panel * { box-sizing:border-box; }
      .dm-panel { min-width:0; overflow-wrap:anywhere; }
      .dm-head, .dm-head-actions, .dm-form-actions, .dm-create-actions, .dm-foot { flex-wrap:wrap; }
      .dm-head > *, .dm-meta-row > *, .dm-select, .dm-doc-title { min-width:0; max-width:100%; }
      .dm-select-field { flex:1 1 120px; }
      .dm-panel :focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:2px; }
      @media (max-width:420px) {
        .dm-panel .dm-head, .dm-panel .dm-search, .dm-panel .dm-filters, .dm-panel .dm-scroll { padding-left:12px; padding-right:12px; }
        .dm-head-actions { width:100%; justify-content:space-between; }
        .dm-panel .dm-select { width:100%; }
        .dm-meta-row { flex-direction:column; gap:2px; }
      }
      @media (pointer:coarse) {
        .dm-btn, .dm-select, .dm-input, .dm-choice-btn { min-height:44px; }
      }
      .dm-panel { display:flex; flex-direction:column; height:100%; min-height:0; overflow:hidden;
        background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary);
        font-size:13px; line-height:1.45; }
      .dm-head { display:flex; align-items:flex-start; justify-content:space-between; gap:12px;
        padding:14px 20px 12px; border-bottom:1px solid var(--dsw-alias-border-l1); }
      .dm-title { font-size:15px; font-weight:600; letter-spacing:-0.01em; }
      .dm-subtitle { margin-top:2px; font-size:12px; color:var(--dsw-alias-label-secondary); }
      .dm-head-actions { display:flex; align-items:center; gap:8px; }
      .dm-status { display:inline-flex; align-items:center; gap:6px; font-size:12px;
        color:var(--dsw-alias-label-secondary); white-space:nowrap; }
      .dm-dot { width:7px; height:7px; border-radius:50%; background:var(--dsw-alias-state-idle-primary); }
      .dm-status.is-on .dm-dot { background:var(--dsw-alias-state-success-primary); }
      .dm-btn { display:inline-flex; align-items:center; gap:6px; font:inherit; font-size:12.5px;
        padding:6px 11px; border-radius:8px; border:1px solid var(--dsw-alias-border-l1);
        background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary);
        cursor:pointer; text-decoration:none; }
      .dm-btn:hover:not(:disabled) { background:var(--dsw-alias-bg-layer-1); border-color:var(--dsw-alias-border-l2); }
      .dm-btn:disabled { opacity:0.5; cursor:default; }
      .dm-btn-primary { font-weight:600; color:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); }
      .dm-search { display:flex; gap:8px; padding:12px 20px; border-bottom:1px solid var(--dsw-alias-border-l1); }
      .dm-input { flex:1; min-width:0; font:inherit; padding:7px 10px; border-radius:8px;
        border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1);
        color:var(--dsw-alias-label-primary); }
      .dm-input::placeholder { color:var(--dsw-alias-label-secondary); }
      .dm-input:focus { outline:none; border-color:var(--dsw-alias-brand-primary); }
      .dm-scroll { flex:1; min-height:0; overflow:auto; padding:12px 20px 16px; }
      .dm-listhead { display:flex; justify-content:space-between; align-items:baseline; margin-bottom:6px;
        font-size:11px; letter-spacing:0.06em; text-transform:uppercase; color:var(--dsw-alias-label-secondary); }
      .dm-count { font-variant-numeric:tabular-nums; letter-spacing:0; }
      .dm-list { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:2px; }
      .dm-item-btn { display:flex; flex-direction:column; gap:3px; width:100%; text-align:left; font:inherit;
        background:none; border:1px solid transparent; border-radius:8px; padding:8px 10px;
        cursor:pointer; color:inherit; }
      .dm-item-btn:hover { background:var(--dsw-alias-bg-layer-2); border-color:var(--dsw-alias-border-l1); }
      .dm-item-title { font-size:13px; font-weight:600; }
      .dm-item-snippet { font-size:12px; color:var(--dsw-alias-label-secondary); overflow:hidden;
        display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; }
      .dm-item-meta { font-size:11px; color:var(--dsw-alias-label-secondary); opacity:0.85; }
      .dm-empty { padding:16px 0; color:var(--dsw-alias-label-secondary); }
      .dm-error { margin:6px 0; font-size:12.5px; color:var(--dsw-alias-state-error-primary); white-space:pre-wrap; }
      .dm-card { max-width:600px; padding:16px; border-radius:12px;
        border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); }
      .dm-card-title { margin-bottom:6px; font-size:13.5px; font-weight:600; }
      .dm-card-body { margin:0 0 12px; font-size:12.5px; color:var(--dsw-alias-label-secondary); }
      .dm-form { display:flex; flex-direction:column; gap:10px; }
      .dm-field { display:flex; flex-direction:column; gap:4px; }
      .dm-label { font-size:12px; color:var(--dsw-alias-label-secondary); }
      .dm-hint { margin:0; font-size:11.5px; color:var(--dsw-alias-label-secondary); }
      .dm-form-actions { display:flex; gap:8px; margin-top:4px; }
      .dm-meta { display:flex; flex-direction:column; gap:4px; margin-top:4px; padding-top:10px;
        border-top:1px solid var(--dsw-alias-border-l1); }
      .dm-meta-row { display:flex; justify-content:space-between; gap:12px; font-size:12px; }
      .dm-meta-label { color:var(--dsw-alias-label-secondary); }
      .dm-meta-value { overflow-wrap:anywhere; }
      .dm-doc-actions { display:flex; gap:8px; margin-bottom:12px; flex-wrap:wrap; }
      .dm-doc-title { margin:0 0 8px; font-size:17px; font-weight:600; letter-spacing:-0.01em; }
      .dm-chips { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:12px; }
      .dm-filters { display:flex; flex-wrap:wrap; align-items:flex-end; gap:8px 10px;
        padding:10px 20px; border-bottom:1px solid var(--dsw-alias-border-l1); }
      .dm-select-field { display:flex; flex-direction:column; gap:3px; min-width:0; }
      .dm-select { font:inherit; font-size:12.5px; max-width:15rem; padding:5px 8px; border-radius:8px;
        border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1);
        color:var(--dsw-alias-label-primary); }
      .dm-select:focus { outline:none; border-color:var(--dsw-alias-brand-primary); }
      .dm-filter-reset { margin-left:auto; }
      .dm-create-actions { display:flex; gap:8px; width:100%; }
      .dm-create-form { display:flex; align-items:center; gap:8px; width:100%; flex-wrap:wrap; }
      .dm-create-input { max-width:16rem; }
      .dm-create-body { flex:1 1 100%; min-height:5rem; max-width:44rem; }
      .dm-textarea { resize:vertical; min-height:14rem; font-family:ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size:12.5px; line-height:1.55; }
      .dm-saved { margin:0 0 8px; font-size:12px; color:var(--dsw-alias-state-success-primary); }
      .dm-chip { padding:2px 8px; border-radius:999px; font-size:11px;
        border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1);
        color:var(--dsw-alias-label-secondary); }
      .dm-doc-body { margin:0; padding:14px; border-radius:10px; white-space:pre-wrap; overflow-wrap:anywhere;
        font-family:inherit; font-size:13px; line-height:1.6;
        border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); }
      .dm-choice { display:flex; gap:8px; flex-wrap:wrap; }
      .dm-choice-btn { flex:1 1 200px; display:flex; flex-direction:column; gap:2px; text-align:left;
        padding:9px 11px; border-radius:10px; font:inherit; cursor:pointer; color:inherit;
        border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-2); }
      .dm-choice-btn:hover:not(:disabled) { border-color:var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1); }
      .dm-choice-btn.is-active { border-color:var(--dsw-alias-brand-primary);
        box-shadow:inset 0 0 0 1px var(--dsw-alias-brand-primary); }
      .dm-choice-btn:disabled { opacity:0.55; cursor:default; }
      .dm-choice-title { font-size:12.5px; font-weight:600; }
      .dm-choice-hint { font-size:11px; color:var(--dsw-alias-label-secondary); }
      .dm-stack { display:flex; flex-direction:column; gap:6px; }
      .dm-oauth { display:flex; flex-direction:column; gap:8px; padding:12px; border-radius:10px;
        border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-base); }
      .dm-oauth-head { display:flex; align-items:center; justify-content:space-between; gap:8px; }
      .dm-oauth .dm-card-body { margin:0; }
      .dm-oauth .dm-form-actions { margin:0; }
      .dm-oauth-link { display:flex; flex-direction:column; gap:6px; padding-top:8px;
        border-top:1px dashed var(--dsw-alias-border-l1); }
      .dm-oauth-link-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
      .dm-oauth-link-input { font-size:11.5px; font-family:ui-monospace, SFMono-Regular, Menlo, monospace; }
      .dm-foot { display:flex; align-items:center; gap:10px; flex-wrap:wrap; padding:10px 20px;
        border-top:1px solid var(--dsw-alias-border-l1); font-size:11.5px;
        color:var(--dsw-alias-label-secondary); }
      .dm-tools { display:inline-flex; flex-wrap:wrap; gap:6px; }
      .dm-tool { padding:1px 6px; border-radius:6px; font-size:10.5px;
        font-family:ui-monospace, SFMono-Regular, Menlo, monospace;
        border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-2); }
      .dm-foot-link { margin-left:auto; color:var(--dsw-alias-brand-primary); text-decoration:none; }
      .dm-foot-link:hover { text-decoration:underline; }
    `

    /**
     * Call the Host bridge.
     *
     * @param {string} method - bridge method.
     * @param {Record<string, unknown>} [params] - method input.
     * @returns {Promise<any>} the flattened result.
     */
    async function rpc(method, params) {
      let response
      try {
        response = await fetch(RPC_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ method, params: params ?? null }),
        })
      } catch (error) {
        throw new Error(`The DocsMint bridge is unreachable: ${error && error.message ? error.message : String(error)}`)
      }
      if (response.status === 401 || response.status === 403) {
        throw new Error('The Harness refused this page request. Reload the page and try again.')
      }
      let payload
      try {
        payload = await response.json()
      } catch {
        payload = undefined
      }
      if (!payload || typeof payload !== 'object') throw new Error(`Unexpected DocsMint bridge response (${response.status}).`)
      if (!payload.ok) {
        const error = new Error(payload.message || `DocsMint request failed (${response.status}).`)
        error.code = payload.code
        throw error
      }
      return payload
    }

    /**
     * @param {unknown} error
     * @returns {string} the message to show the user.
     */
    function errorText(error) {
      return error instanceof Error && error.message ? error.message : String(error)
    }

    /* MARK:BEGIN — outlines of the official DocsMint mark ("dm" + leaf), traced
     * from the brand asset and simplified to 0.991 mask overlap, so the sidebar
     * shows the real logo instead of an approximation. `MARK_GLYPH` is filled
     * with `currentColor` (both themes), `MARK_LEAF` keeps the brand mint. */
    const MARK_VIEWBOX = '12 27 230 170'
    const MARK_MINT = '#19B3A8'
    const MARK_GLYPH = 'M74 87L97 87L97 191L91 191L91 190L89 190L89 191L80 191L80 190L75 190L75 183L71 187L69 187L68 189L60 191L60 192L43 192L43 191L37 190L37 189L33 188L32 186L30 186L24 180L24 178L22 177L22 175L21 175L21 173L20 173L20 171L18 169L17 161L16 161L16 145L17 145L18 137L19 137L20 132L22 131L23 127L31 119L33 119L33 118L35 118L35 117L37 117L39 115L46 114L46 113L59 113L59 114L65 115L65 116L67 116L67 117L69 117L70 119L73 120L73 88L74 88ZM148 113L160 113L160 114L166 115L169 118L171 118L175 122L175 124L177 124L178 121L180 121L182 118L184 118L185 116L188 116L190 114L194 114L194 113L209 114L209 115L214 116L215 118L217 118L222 123L222 125L223 125L223 127L225 129L225 132L226 132L226 137L227 137L227 190L226 191L204 191L203 190L203 146L202 146L201 139L198 136L195 136L195 135L189 135L189 136L184 137L182 139L181 143L180 143L180 148L179 148L179 191L156 191L155 190L155 141L154 141L154 139L151 136L148 136L148 135L143 135L143 136L138 137L135 140L134 145L133 145L133 191L109 191L109 115L132 115L132 123L133 123L137 118L139 118L139 117L141 117L141 116L143 116L145 114L148 114ZM56 134L56 135L52 135L52 136L49 136L48 138L46 138L45 141L42 144L42 147L41 147L42 162L43 162L43 164L48 169L50 169L52 171L62 171L62 170L66 169L70 165L70 163L72 161L72 158L73 158L73 147L72 147L72 144L71 144L70 140L67 137L59 135L59 134Z'
    const MARK_LEAF = 'M203 31L238 31L238 67L237 67L236 73L235 73L234 77L231 79L231 81L227 85L225 85L221 89L218 89L218 90L215 90L215 91L210 91L210 92L183 92L183 90L190 84L190 82L197 76L197 74L202 70L202 68L208 63L208 61L211 58L209 58L199 69L197 69L188 79L186 79L178 87L178 58L179 58L179 54L180 54L181 48L184 45L184 43L190 37L192 37L193 35L195 35L195 34L197 34L199 32L203 32ZM213 56L211 57L211 58L213 57Z'
    /* MARK:END */

    /**
     * The sidebar cell: the DocsMint mark — "dm" with the brand leaf — taken from
     * the brand asset itself. Letters inherit `currentColor`; the leaf stays mint.
     */
    function PanelIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 20
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: MARK_VIEWBOX,
          fill: 'none',
          'aria-hidden': true,
          focusable: 'false',
          style: { display: 'block' },
        },
        h('path', { d: MARK_GLYPH, fill: 'currentColor', fillRule: 'evenodd' }),
        h('path', { d: MARK_LEAF, fill: MARK_MINT, fillRule: 'evenodd' }),
      )
    }

    /**
     * Seed the setup form from the Host's current connection state.
     *
     * @param {any} current - the form as it stands.
     * @param {any} state - the bridge's connection state.
     * @returns {any} the next form.
     */
    function formFromState(current, state) {
      const deployment = state?.deployment === 'self-hosted' ? 'self-hosted' : 'cloud'
      const mode = state?.mode === 'mcp' ? 'mcp' : 'api'
      return {
        ...current,
        workspace: state?.workspace || '',
        deployment,
        mode,
        baseUrl: deployment === 'self-hosted' ? state?.apiBase || '' : '',
      }
    }

    /**
     * Build the panel component bound to one translator.
     *
     * @param {(key: string) => string} t - namespaced translator.
     * @returns {Function} the React component for the `docsmint` main panel.
     */
    function createPanel(t) {
      return function DocsMintPanel() {
        const [connection, setConnection] = React.useState(null)
        const [syncedAt, setSyncedAt] = React.useState(0)
        const [loadingMore, setLoadingMore] = React.useState(false)
        const [hasMore, setHasMore] = React.useState(true)
        const listRef = React.useRef({ generation: 0, page: 1, pending: false, mounted: true })
        React.useEffect(() => {
          listRef.current.mounted = true
          return () => { listRef.current.mounted = false; listRef.current.generation++ }
        }, [])

        function resetPaging() {
          listRef.current.generation++
          listRef.current.page = 1
          listRef.current.pending = false
          setLoadingMore(false)
          setHasMore(true)
        }

        async function fetchFirstPage(selection = filters, order = sort) {
          resetPaging()
          const generation = listRef.current.generation
          const list = await rpc('list', { ...documentListParams(selection, order), page: 1 })
          if (!listRef.current.mounted || generation !== listRef.current.generation) return null
          setItems(uniqueItems(list.items || []))
          setTotal(list.total ?? 0)
          setSyncedAt(Date.now())
          return list
        }

        function uniqueItems(rows) {
          const seen = new Set()
          return rows.filter(item => !seen.has(item.id) && seen.add(item.id))
        }

        async function loadMore() {
          const ref = listRef.current
          if (ref.pending || busy || submitted || !hasMore) return
          ref.pending = true
          const generation = ref.generation
          const nextPage = ref.page + 1
          setLoadingMore(true)
          setNotice('')
          try {
            const list = await rpc('list', { ...documentListParams(filters, sort), page: nextPage })
            if (!ref.mounted || generation !== ref.generation) return
            const seen = new Set(items.map(item => item.id))
            const added = uniqueItems(list.items || []).filter(item => !seen.has(item.id))
            setHasMore(added.length > 0)
            setItems(current => current.concat(added))
            setTotal(list.total ?? total)
            setSyncedAt(Date.now())
            ref.page = nextPage
          } catch (error) {
            if (ref.mounted && generation === ref.generation) setNotice(errorText(error))
          } finally {
            if (ref.mounted && generation === ref.generation) {
              ref.pending = false
              setLoadingMore(false)
            }
          }
        }

        const [items, setItems] = React.useState([])
        const [total, setTotal] = React.useState(0)
        const [query, setQuery] = React.useState('')
        const [submitted, setSubmitted] = React.useState('')
        const [document, setDocument] = React.useState(null)
        const [busy, setBusy] = React.useState(true)
        const [notice, setNotice] = React.useState('')
        const [editing, setEditing] = React.useState(false)
        const [form, setForm] = React.useState({ apiKey: '', workspace: '', deployment: 'cloud', mode: 'api', baseUrl: '' })
        const [formError, setFormError] = React.useState('')
        const [waitingOAuth, setWaitingOAuth] = React.useState(false)
        const [pendingLink, setPendingLink] = React.useState('')
        const [linkNote, setLinkNote] = React.useState('')
        const [copiedLink, setCopiedLink] = React.useState(false)
        const [filters, setFilters] = React.useState({ workspaceId: '', categoryId: '', folderId: '' })
        const [sort, setSort] = React.useState('updated-desc')
        const [structure, setStructure] = React.useState({ workspaces: [], folders: [], categories: [] })
        const [editDraft, setEditDraft] = React.useState(null)
        const [savedHint, setSavedHint] = React.useState('')
        const [createDraft, setCreateDraft] = React.useState(null)
        const pollRef = React.useRef(undefined)

        React.useEffect(
          () => () => {
            if (pollRef.current) clearInterval(pollRef.current)
          },
          [],
        )

        React.useEffect(() => {
          let live = true
          void (async () => {
            try {
              const state = await rpc('state')
              if (!live) return
              setConnection(state)
              if (state.configured) {
                const list = await fetchFirstPage()
                if (!live || !list) return
                await loadStructure(live)
              } else {
                setEditing(true)
                setForm((current) => formFromState(current, state))
              }
            } catch (error) {
              if (live) setNotice(errorText(error))
            } finally {
              if (live) setBusy(false)
            }
          })()
          return () => {
            live = false
          }
        }, [])

        /**
         * Load the workspaces, folders and categories the filter selects offer.
         * A transport that cannot list one of them simply yields an empty list.
         *
         * @param {boolean} [live] - false once the component unmounted.
         */
        async function loadStructure(live = true) {
          /** @type {any} */
          const next = { workspaces: [], folders: [], categories: [] }
          for (const kind of ['workspaces', 'folders', 'categories']) {
            try {
              const result = await rpc('structure', { kind })
              next[kind] = Array.isArray(result.items) ? result.items : []
            } catch {
              next[kind] = []
            }
          }
          if (live) setStructure(next)
          return next
        }

        /**
         * @param {{ workspaceId?: string, categoryId?: string, folderId?: string }} next - the filter set.
         */
        async function applyFilters(next, nextSort = sort) {
          resetPaging()
          setSort(nextSort)
          setFilters(next)
          setBusy(true)
          setNotice('')
          try {
            const list = await fetchFirstPage(next, nextSort)
            if (!list) return
            setSubmitted('')
            setDocument(null)
            setEditDraft(null)
          } catch (error) {
            setNotice(errorText(error))
          } finally {
            setBusy(false)
          }
        }

        /**
         * Create whatever the toolbar asked for: a category, a folder, or a
         * document inside the selected folder. A new document opens in the panel.
         */
        async function submitCreate() {
          if (!createDraft || !createDraft.name.trim()) return
          setBusy(true)
          setNotice('')
          try {
            if (createDraft.kind === 'category') {
              await rpc('createCategory', {
                name: createDraft.name.trim(),
                workspaceId: filters.workspaceId || undefined,
              })
              setCreateDraft(null)
              await loadStructure()
            } else if (createDraft.kind === 'folder') {
              await rpc('createFolder', {
                name: createDraft.name.trim(),
                categoryId: filters.categoryId || undefined,
                workspaceId: filters.workspaceId || undefined,
              })
              setCreateDraft(null)
              await loadStructure()
            } else {
              const created = await rpc('create', {
                title: createDraft.name.trim(),
                content: createDraft.content ?? '',
                workspaceId: filters.workspaceId || undefined,
                categoryId: filters.categoryId || undefined,
                folderId: filters.folderId || undefined,
              })
              setCreateDraft(null)
              setSubmitted('')
              setEditDraft(null)
              setSavedHint(t('doc.created'))
              setDocument(created.document)
              try {
                const list = await fetchFirstPage()
                if (!list) return
              } catch {
                // The document exists; a stale list is only cosmetic.
              }
            }
          } catch (error) {
            setNotice(errorText(error))
          } finally {
            setBusy(false)
          }
        }

        async function reload() {
          resetPaging()
          setBusy(true)
          setNotice('')
          try {
            const state = await rpc('state')
            setConnection(state)
            if (state.configured) {
              const list = await fetchFirstPage()
              if (!list) return
              setSubmitted('')
              setDocument(null)
              setEditDraft(null)
              await loadStructure()
            } else {
              setItems([])
              setTotal(0)
              setEditing(true)
              setForm((current) => formFromState(current, state))
            }
          } catch (error) {
            setNotice(errorText(error))
          } finally {
            setBusy(false)
          }
        }

        async function openDocument(id) {
          setBusy(true)
          setNotice('')
          setSavedHint('')
          setEditDraft(null)
          try {
            const result = await rpc('get', { id })
            setDocument(result.document)
          } catch (error) {
            setNotice(errorText(error))
          } finally {
            setBusy(false)
          }
        }

        async function submitSearch(event) {
          resetPaging()
          event.preventDefault()
          const text = query.trim()
          if (!text) {
            await reload()
            return
          }
          setBusy(true)
          setNotice('')
          try {
            const result = await rpc('search', { query: text, limit: 30, workspaceId: filters.workspaceId || undefined, categoryId: filters.categoryId || undefined })
            setItems(result.items || [])
            setTotal(result.total || 0)
            setSubmitted(text)
            setDocument(null)
          } catch (error) {
            setNotice(errorText(error))
          } finally {
            setBusy(false)
          }
        }

        async function loadFirstPage() {
          const list = await fetchFirstPage()
          if (!list) return
          setSubmitted('')
          setDocument(null)
          setEditDraft(null)
        }

        /**
         * Save the open document's title and Markdown body, then refresh the row
         * so the list matches the stored state.
         */
        async function saveDraft() {
          if (!document || !editDraft) return
          setBusy(true)
          setNotice('')
          setSavedHint('')
          try {
            const result = await rpc('update', {
              id: document.id,
              title: editDraft.title,
              content: editDraft.content,
            })
            setDocument(result.document)
            setEditDraft(null)
            setSavedHint(t('doc.saved'))
            try {
              const list = await fetchFirstPage()
              if (!list) return
            } catch {
              // The save already succeeded; a stale list is only cosmetic.
            }
          } catch (error) {
            setNotice(errorText(error))
          } finally {
            setBusy(false)
          }
        }

        async function saveConnection(event) {
          resetPaging()
          event.preventDefault()
          setFormError('')
          const cloudMcp = (form.mode || 'api') === 'mcp' && form.deployment !== 'self-hosted'
          if (!cloudMcp && !form.apiKey.trim() && !connection?.configured) {
            setFormError(t('panel.setup.keyRequired'))
            return
          }
          if (form.deployment === 'self-hosted' && !form.baseUrl.trim()) {
            setFormError(t('panel.setup.urlRequired'))
            return
          }
          setBusy(true)
          try {
            const state = await rpc('save', {
              apiKey: form.apiKey,
              workspace: form.workspace,
              deployment: form.deployment,
              mode: form.mode || 'api',
              baseUrl: form.deployment === 'self-hosted' ? form.baseUrl : '',
            })
            setConnection(state)
            setForm((current) => ({ ...formFromState(current, state), apiKey: '' }))
            setEditing(false)
            if (state.note) setNotice(state.note)
            if (state.configured) {
              try {
                await loadFirstPage()
              } catch (error) {
                setItems([])
                setTotal(0)
                setNotice(errorText(error))
              }
            }
          } catch (error) {
            setFormError(errorText(error))
          } finally {
            setBusy(false)
          }
        }

        async function connectOAuth() {
          resetPaging()
          setFormError('')
          setBusy(true)
          try {
            await rpc('save', { deployment: 'cloud', mode: 'mcp' })
            const started = await rpc('mcpConnect')
            if (!started.ok) {
              setFormError(started.message)
              return
            }
            const opened = window.open(started.authorizeUrl, '_blank', 'noopener,noreferrer')
            setPendingLink(started.authorizeUrl)
            setLinkNote(opened ? '' : t('panel.mcp.copyFailed'))
            setWaitingOAuth(true)
            setCopiedLink(false)
            const deadline = Date.now() + 5 * 60_000
            if (pollRef.current) clearInterval(pollRef.current)
            pollRef.current = setInterval(() => {
              void (async () => {
                try {
                  const state = await rpc('state')
                  setConnection(state)
                  if (state.mcp && state.mcp.connected) {
                    clearInterval(pollRef.current)
                    pollRef.current = undefined
                    setWaitingOAuth(false)
                    setEditing(false)
                    setNotice('')
                    setPendingLink('')
                    setLinkNote('')
                    setCopiedLink(false)
                    await loadFirstPage()
                  } else if (Date.now() > deadline) {
                    clearInterval(pollRef.current)
                    pollRef.current = undefined
                    setWaitingOAuth(false)
                    setFormError(t('panel.mcp.failed'))
                  }
                } catch {
                  // The Host may be busy completing the exchange; keep polling.
                }
              })()
            }, 2500)
          } catch (error) {
            setFormError(errorText(error))
          } finally {
            setBusy(false)
          }
        }

        /**
         * The consent link to offer. The Host keeps the newest live pending link,
         * so it survives a page reload while that consent is still valid.
         */
        function authorizeLink() {
          if (pendingLink) return pendingLink
          const link = connection?.mcp?.authorizeUrl
          return typeof link === 'string' ? link : ''
        }

        async function copyText(value) {
          try {
            if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
              await navigator.clipboard.writeText(value)
              return true
            }
          } catch {
            // Fall through to the selection-based copy.
          }
          try {
            const holder = document.createElement('textarea')
            holder.value = value
            holder.setAttribute('readonly', '')
            holder.style.position = 'fixed'
            holder.style.top = '-1000px'
            holder.style.opacity = '0'
            document.body.appendChild(holder)
            holder.select()
            const copied = typeof document.execCommand === 'function' && document.execCommand('copy')
            document.body.removeChild(holder)
            return copied === true
          } catch {
            return false
          }
        }

        async function copyAuthorizeLink() {
          const link = authorizeLink()
          if (!link) return
          const copied = await copyText(link)
          setCopiedLink(copied)
          setLinkNote(copied ? '' : t('panel.mcp.copyFailed'))
          if (copied) setTimeout(() => setCopiedLink(false), 2500)
        }

        function reopenAuthorizeLink() {
          const link = authorizeLink()
          if (!link) return
          const opened = window.open(link, '_blank', 'noopener,noreferrer')
          if (!opened) setLinkNote(t('panel.mcp.copyFailed'))
        }

        function oauthLinkBlock() {
          const link = authorizeLink()
          if (!link) return null
          return h(
            'div',
            { className: 'dm-oauth-link' },
            h('p', { className: 'dm-hint' }, t('panel.mcp.linkHint')),
            h(
              'div',
              { className: 'dm-oauth-link-row' },
              h('input', {
                className: 'dm-input dm-oauth-link-input',
                type: 'text',
                readOnly: true,
                value: link,
                spellCheck: false,
                'aria-label': t('panel.mcp.consentLink'),
                onFocus: (event) => event.currentTarget.select(),
                onClick: (event) => event.currentTarget.select(),
              }),
              h(
                'button',
                { type: 'button', className: 'dm-btn', disabled: busy, onClick: () => void copyAuthorizeLink() },
                t(copiedLink ? 'panel.mcp.copied' : 'panel.mcp.copyLink'),
              ),
              h(
                'button',
                { type: 'button', className: 'dm-btn', disabled: busy, onClick: reopenAuthorizeLink },
                t('panel.mcp.reopen'),
              ),
            ),
            linkNote ? h('p', { className: 'dm-hint dm-link-note' }, linkNote) : null,
          )
        }

        async function disconnectOAuth() {
          resetPaging()
          setBusy(true)
          setFormError('')
          setPendingLink('')
          setLinkNote('')
          setCopiedLink(false)
          try {
            const state = await rpc('mcpDisconnect')
            setConnection(state)
            setItems([])
            setTotal(0)
          } catch (error) {
            setFormError(errorText(error))
          } finally {
            setBusy(false)
          }
        }

        const configured = Boolean(connection?.configured)
        const webBase = connection?.webBase || SITE
        const tools = Array.isArray(connection?.tools) ? connection.tools : []
        const selfHosted = connection?.deployment === 'self-hosted'
        const instanceLabel = selfHosted ? t('panel.instance.selfHosted') : t('panel.instance.cloud')

        function field(label, input) {
          return h('label', { className: 'dm-field' }, h('span', { className: 'dm-label' }, label), input)
        }

        function chips(entries) {
          const visible = entries.filter((entry) => entry && entry[1])
          if (visible.length === 0) return null
          return h(
            'div',
            { className: 'dm-chips' },
            visible.map((entry) => h('span', { key: entry[0], className: 'dm-chip' }, `${entry[0]}: ${entry[1]}`)),
          )
        }

        function group(label, node) {
          return h('div', { className: 'dm-field' }, h('span', { className: 'dm-label' }, label), node)
        }

        function choice(value) {
          const active = (form.deployment || 'cloud') === value
          const title = value === 'cloud' ? t('panel.instance.cloud') : t('panel.instance.selfHosted')
          const hint = value === 'cloud' ? t('panel.setup.cloudHint') : t('panel.setup.selfHostedHint')
          return h(
            'button',
            {
              key: value,
              type: 'button',
              className: `dm-choice-btn${active ? ' is-active' : ''}`,
              'aria-pressed': active,
              disabled: busy || connection?.endpointLocked === true,
              onClick: () => setForm((current) => ({ ...current, deployment: value })),
            },
            h('span', { className: 'dm-choice-title' }, title),
            h('span', { className: 'dm-choice-hint' }, hint),
          )
        }

        function metaRow(label, value) {
          if (value === undefined || value === null || value === '') return null
          return h(
            'div',
            { className: 'dm-meta-row' },
            h('span', { className: 'dm-meta-label' }, label),
            h('span', { className: 'dm-meta-value' }, String(value)),
          )
        }

        function keyField() {
          return h(
            'div',
            { className: 'dm-stack' },
            field(
              t('panel.setup.key'),
              h('input', {
                className: 'dm-input',
                type: 'password',
                autoComplete: 'off',
                spellCheck: false,
                placeholder: t('panel.setup.keyPlaceholder'),
                value: form.apiKey,
                onChange: (event) => setForm((current) => ({ ...current, apiKey: event.target.value })),
              }),
            ),
            h('p', { className: 'dm-hint' }, configured ? t('panel.setup.keepKey') : t('panel.setup.keyRequired')),
          )
        }

        function urlField() {
          return h(
            'div',
            { className: 'dm-stack' },
            field(
              t('panel.setup.url'),
              h('input', {
                className: 'dm-input',
                type: 'url',
                inputMode: 'url',
                spellCheck: false,
                placeholder: t('panel.setup.urlPlaceholder'),
                value: form.baseUrl,
                onChange: (event) => setForm((current) => ({ ...current, baseUrl: event.target.value })),
              }),
            ),
            h('p', { className: 'dm-hint' }, t('panel.setup.urlHint')),
          )
        }

        function workspaceField() {
          return field(
            t('panel.setup.workspace'),
            h('input', {
              className: 'dm-input',
              type: 'text',
              autoComplete: 'off',
              spellCheck: false,
              placeholder: t('panel.setup.workspacePlaceholder'),
              value: form.workspace,
              onChange: (event) => setForm((current) => ({ ...current, workspace: event.target.value })),
            }),
          )
        }

        function modeChoice(value) {
          const active = (form.mode || 'api') === value
          return h(
            'button',
            {
              key: value,
              type: 'button',
              className: `dm-choice-btn${active ? ' is-active' : ''}`,
              'aria-pressed': active,
              disabled: busy || connection?.modeLocked === true,
              onClick: () => setForm((current) => ({ ...current, mode: value })),
            },
            h('span', { className: 'dm-choice-title' }, t(value === 'api' ? 'panel.mode.api' : 'panel.mode.mcp')),
            h('span', { className: 'dm-choice-hint' }, t(value === 'api' ? 'panel.mode.apiHint' : 'panel.mode.mcpHint')),
          )
        }

        function oauthBlock() {
          const mcp = connection?.mcp
          const connected = Boolean(mcp?.connected)
          const tools = mcp && typeof mcp.tools === 'number' ? mcp.tools : null
          return h(
            'section',
            { className: 'dm-oauth' },
            h(
              'div',
              { className: 'dm-oauth-head' },
              h(
                'span',
                { className: `dm-status${connected ? ' is-on' : ''}` },
                h('span', { className: 'dm-dot' }),
                t(connected ? 'panel.mcp.connected' : 'panel.notConnected'),
              ),
              tools === null ? null : h('span', { className: 'dm-hint' }, `${t('panel.mcp.tools')}: ${tools}`),
            ),
            h('p', { className: 'dm-card-body' }, t('panel.mcp.oauthBody')),
            h(
              'div',
              { className: 'dm-form-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dm-btn dm-btn-primary',
                  disabled: busy || waitingOAuth,
                  onClick: () => void connectOAuth(),
                },
                t(connected ? 'panel.mcp.reconnect' : 'panel.mcp.connect'),
              ),
              connected
                ? h(
                    'button',
                    { type: 'button', className: 'dm-btn', disabled: busy, onClick: () => void disconnectOAuth() },
                    t('panel.mcp.disconnect'),
                  )
                : null,
            ),
            waitingOAuth ? h('p', { className: 'dm-hint' }, t('panel.mcp.waiting')) : null,
            metaRow(t('panel.mcp.endpoint'), mcp?.endpoint),
            oauthLinkBlock(),
            metaRow(t('panel.mcp.server'), mcp?.server),
            mcp?.expiresAt ? metaRow(t('panel.mcp.expires'), new Date(mcp.expiresAt).toLocaleString()) : null,
          )
        }

        function renderSetup() {
          const mode = form.mode || 'api'
          const selfHosted = form.deployment === 'self-hosted'
          const cloudMcp = mode === 'mcp' && !selfHosted
          return h(
            'div',
            { className: 'dm-scroll' },
            h(
              'section',
              { className: 'dm-card' },
              h('div', { className: 'dm-card-title' }, t('panel.setup.title')),
              h('p', { className: 'dm-card-body' }, t('panel.setup.body')),
              h(
                'form',
                { className: 'dm-form', onSubmit: saveConnection },
                group(
                  t('panel.setup.deployment'),
                  h('div', { className: 'dm-choice' }, choice('cloud'), choice('self-hosted')),
                ),
                group(t('panel.setup.mode'), h('div', { className: 'dm-choice' }, modeChoice('api'), modeChoice('mcp'))),
                selfHosted ? urlField() : null,
                cloudMcp ? null : keyField(),
                mode === 'api' ? workspaceField() : null,
                cloudMcp ? oauthBlock() : null,
                mode === 'mcp' && selfHosted ? h('p', { className: 'dm-hint' }, t('panel.mcp.selfBody')) : null,
                h(
                  'div',
                  { className: 'dm-meta' },
                  metaRow(t('panel.setup.apiBase'), connection?.apiBase || '—'),
                  metaRow(t('panel.source'), connection?.keySource),
                  connection?.endpointLocked
                    ? h('p', { className: 'dm-hint' }, t('panel.setup.endpointLocked'))
                    : null,
                ),
                formError ? h('p', { className: 'dm-error' }, formError) : null,
                connection && connection.canStoreCredentials === false
                  ? h('p', { className: 'dm-hint' }, t('panel.setup.noStore'))
                  : null,
                h(
                  'div',
                  { className: 'dm-form-actions' },
                  h(
                    'button',
                    {
                      type: 'submit',
                      className: 'dm-btn dm-btn-primary',
                      disabled: busy || (connection ? connection.canStoreCredentials === false : false),
                    },
                    t('panel.setup.save'),
                  ),
                  configured
                    ? h(
                        'button',
                        {
                          type: 'button',
                          className: 'dm-btn',
                          disabled: busy,
                          onClick: () => {
                            setEditing(false)
                            setFormError('')
                          },
                        },
                        t('panel.setup.cancel'),
                      )
                    : null,
                ),
              ),
            ),
          )
        }

        /**
         * @param {string} label - select caption.
         * @param {string} value - current value.
         * @param {any[]} options - rendered options.
         * @param {(value: string) => void} onChange - change handler.
         * @returns {any} one labelled select.
         */
        function selectField(label, value, options, onChange) {
          return h(
            'label',
            { className: 'dm-select-field' },
            h('span', { className: 'dm-label' }, label),
            h(
              'select',
              {
                className: 'dm-select',
                value,
                disabled: busy,
                onChange: (event) => onChange(event.target.value),
              },
              options,
            ),
          )
        }

        /** Folders offered by the folder select, narrowed to the chosen category. */
        const visibleFolders = filters.categoryId
          ? structure.folders.filter((folder) => folder.categoryId === filters.categoryId)
          : structure.folders

        // Listing filters and sort apply on the server before pagination.
        const visibleItems = items

        /**
         * The filter row: workspace, category, folder and sort. Filters and sorting are resolved by the DocsMint server before pagination.
         *
         * @returns {any} the filter bar, or null while search results are shown.
         */
        function renderFilters() {
          if (submitted || !configured) return null
          const none = h('option', { key: 'all', value: '' }, t('filter.all'))
          const active = Boolean(filters.workspaceId || filters.categoryId || filters.folderId)
          return h(
            'div',
            { className: 'dm-filters' },
            selectField(
              t('filter.workspace'),
              filters.workspaceId,
              [
                none,
                ...structure.workspaces.map((workspace) =>
                  h('option', { key: workspace.id, value: workspace.id }, workspace.name || workspace.slug || workspace.id),
                ),
              ],
              (value) => void applyFilters({ workspaceId: value, categoryId: '', folderId: '' }),
            ),
            selectField(
              t('filter.category'),
              filters.categoryId,
              [none, ...structure.categories.map((category) => h('option', { key: category.id, value: category.id }, category.name))],
              (value) => void applyFilters({ ...filters, categoryId: value, folderId: '' }),
            ),
            selectField(
              t('filter.folder'),
              filters.folderId,
              [none, ...visibleFolders.map((folder) => h('option', { key: folder.id, value: folder.id }, folder.name))],
              (value) => void applyFilters({ ...filters, folderId: value }),
            ),
            selectField(t('filter.sort'), sort, [
              h('option', { key: 'updated-desc', value: 'updated-desc' }, t('sort.updatedDesc')),
              h('option', { key: 'updated-asc', value: 'updated-asc' }, t('sort.updatedAsc')),
              h('option', { key: 'title', value: 'title' }, t('sort.title')),
              h('option', { key: 'created-desc', value: 'created-desc' }, t('sort.createdDesc')),
            ], (value) => void applyFilters(filters, value)),
            h(
              'button',
              {
                type: 'button',
                className: 'dm-btn dm-filter-reset',
                disabled: busy || (!active && sort === 'updated-desc'),
                title: t('filter.reset'),
                onClick: () => {
                  setSort('updated-desc')
                  void applyFilters({ workspaceId: '', categoryId: '', folderId: '' }, 'updated-desc')
                },
              },
              t('filter.reset'),
            ),
            createDraft
              ? h(
                  'form',
                  {
                    className: 'dm-create-form',
                    onSubmit: (event) => {
                      event.preventDefault()
                      void submitCreate()
                    },
                  },
                  h(
                    'span',
                    { className: 'dm-label' },
                    t(
                      createDraft.kind === 'category'
                        ? 'filter.newCategory'
                        : createDraft.kind === 'folder'
                          ? 'filter.newFolder'
                          : 'filter.newDocument',
                    ),
                  ),
                  h('input', {
                    className: 'dm-input dm-create-input',
                    type: 'text',
                    autoFocus: true,
                    placeholder: createDraft.kind === 'document' ? t('doc.titleLabel') : t('filter.namePlaceholder'),
                    value: createDraft.name,
                    onChange: (event) => setCreateDraft({ ...createDraft, name: event.target.value }),
                  }),
                  createDraft.kind === 'document'
                    ? h('textarea', {
                        className: 'dm-input dm-textarea dm-create-body',
                        rows: 6,
                        spellCheck: false,
                        placeholder: t('doc.contentLabel'),
                        value: createDraft.content ?? '',
                        onChange: (event) => setCreateDraft({ ...createDraft, content: event.target.value }),
                      })
                    : null,
                  h('button', { type: 'submit', className: 'dm-btn dm-btn-primary', disabled: busy || !createDraft.name.trim() }, t('filter.create')),
                  h('button', { type: 'button', className: 'dm-btn', onClick: () => setCreateDraft(null) }, t('doc.cancel')),
                )
              : h(
                  'div',
                  { className: 'dm-create-actions' },
                  h(
                    'button',
                    { type: 'button', className: 'dm-btn', disabled: busy, onClick: () => setCreateDraft({ kind: 'category', name: '' }) },
                    t('filter.newCategory'),
                  ),
                  h(
                    'button',
                    { type: 'button', className: 'dm-btn', disabled: busy, onClick: () => setCreateDraft({ kind: 'folder', name: '' }) },
                    t('filter.newFolder'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dm-btn dm-btn-primary',
                      disabled: busy,
                      onClick: () => setCreateDraft({ kind: 'document', name: '', content: '' }),
                    },
                    t('filter.newDocument'),
                  ),
                ),
          )
        }

        function renderDocument() {
          if (editDraft) {
            return h(
              'div',
              { className: 'dm-scroll' },
              notice ? h('p', { className: 'dm-error' }, notice) : null,
              h(
                'div',
                { className: 'dm-doc-actions' },
                h(
                  'button',
                  { type: 'button', className: 'dm-btn', disabled: busy, onClick: () => setEditDraft(null) },
                  t('doc.cancel'),
                ),
                h(
                  'button',
                  { type: 'button', className: 'dm-btn dm-btn-primary', disabled: busy, onClick: () => void saveDraft() },
                  busy ? t('doc.saving') : t('doc.save'),
                ),
              ),
              h(
                'label',
                { className: 'dm-field' },
                h('span', { className: 'dm-label' }, t('doc.titleLabel')),
                h('input', {
                  className: 'dm-input',
                  type: 'text',
                  value: editDraft.title,
                  onChange: (event) => setEditDraft({ ...editDraft, title: event.target.value }),
                }),
              ),
              h(
                'label',
                { className: 'dm-field' },
                h('span', { className: 'dm-label' }, t('doc.contentLabel')),
                h('textarea', {
                  className: 'dm-input dm-textarea',
                  rows: 18,
                  spellCheck: false,
                  value: editDraft.content,
                  onChange: (event) => setEditDraft({ ...editDraft, content: event.target.value }),
                }),
              ),
            )
          }
          return h(
            'div',
            { className: 'dm-scroll' },
            notice ? h('p', { className: 'dm-error' }, notice) : null,
            savedHint ? h('p', { className: 'dm-saved' }, savedHint) : null,
            h(
              'div',
              { className: 'dm-doc-actions' },
              h(
                'button',
                { type: 'button', className: 'dm-btn', disabled: busy, onClick: () => setDocument(null) },
                t('panel.back'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dm-btn',
                  disabled: busy,
                  onClick: () => {
                    setSavedHint('')
                    setEditDraft({ title: document.title, content: document.content || '' })
                  },
                },
                t('doc.edit'),
              ),
              h(
                'a',
                { className: 'dm-btn', href: document.url || webBase, target: '_blank', rel: 'noreferrer noopener' },
                t('panel.open'),
              ),
            ),
            h('h2', { className: 'dm-doc-title' }, document.title),
            chips([
              [t('panel.chip.folder'), document.folder],
              [t('panel.chip.category'), document.category],
              [t('panel.chip.updated'), document.updatedAt],
              [t('panel.chip.visibility'), document.visibility],
            ]),
            h('pre', { className: 'dm-doc-body' }, document.content || t('panel.emptyDocument')),
          )
        }

        function renderList() {
          return h(
            'div',
            { className: 'dm-scroll' },
            notice ? h('p', { className: 'dm-error' }, notice) : null,
            h(
              'div',
              { className: 'dm-listhead' },
              h('span', null, submitted ? t('panel.results') : t('panel.documents')),
              h('span', { className: 'dm-count' }, submitted ? String(total) : `${items.length} / ${total}`),
            ),
            visibleItems.length === 0
              ? h('p', { className: 'dm-empty' }, busy ? t('panel.loading') : submitted ? t('panel.emptySearch') : t('panel.emptyList'))
              : h(
                  'ul',
                  { className: 'dm-list' },
                  visibleItems.map((item) =>
                    h(
                      'li',
                      { key: item.id || item.title },
                      h(
                        'button',
                        { type: 'button', className: 'dm-item-btn', onClick: () => void openDocument(item.id) },
                        h('span', { className: 'dm-item-title' }, item.title),
                        item.snippet ? h('span', { className: 'dm-item-snippet' }, item.snippet) : null,
                        h(
                          'span',
                          { className: 'dm-item-meta' },
                          [item.category, item.folder, item.updatedAt].filter(Boolean).join(' · '),
                        ),
                      ),
                    ),
                  ),
                ),
            !submitted && hasMore && items.length < total
              ? h('div', { className: 'dm-more' },
                  h('button', { type: 'button', className: 'dm-btn', disabled: busy || loadingMore,
                    onClick: () => void loadMore() }, loadingMore ? t('panel.loading') : t('panel.loadMore')))
              : null,
          )
        }

        let body
        if (editing || !configured) body = renderSetup()
        else if (document) body = renderDocument()
        else body = renderList()

        return h(
          'div',
          { className: 'dm-panel' },
          h('style', null, CSS),
          h(
            'header',
            { className: 'dm-head' },
            h(
              'div',
              null,
              h('div', { className: 'dm-title' }, t('panel.title')),
              h(
                'div',
                { className: 'dm-subtitle' },
                configured
                  ? [instanceLabel, connection?.mode === 'mcp' ? t('panel.mode.mcp') : t('panel.mode.api'), connection?.mode === 'mcp' ? null : connection?.workspace]
                      .filter(Boolean)
                      .concat(syncedAt ? `${t('panel.synced')} ${new Date(syncedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : [])
                      .join(' · ')
                  : t('panel.subtitle'),
              ),
            ),
            h(
              'div',
              { className: 'dm-head-actions' },
              h(
                'span',
                { className: `dm-status${configured ? ' is-on' : ''}` },
                h('span', { className: 'dm-dot' }),
                t(configured ? 'panel.connected' : 'panel.notConnected'),
              ),
              h('button', { type: 'button', className: 'dm-btn', disabled: busy, onClick: () => void reload() }, t('panel.refresh')),
            ),
          ),
          h(
            'form',
            { className: 'dm-search', onSubmit: submitSearch },
            h('input', {
              className: 'dm-input',
              type: 'search',
              value: query,
              placeholder: t('panel.searchPlaceholder'),
              'aria-label': t('panel.searchPlaceholder'),
              disabled: !configured,
              onChange: (event) => setQuery(event.target.value),
            }),
            submitted || query
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'dm-btn',
                    disabled: busy || !configured,
                    onClick: () => {
                      setQuery('')
                      setSubmitted('')
                      setDocument(null)
                      void reload()
                    },
                  },
                  t('panel.clear'),
                )
              : null,
            h('button', { type: 'submit', className: 'dm-btn dm-btn-primary', disabled: busy || !configured }, t('panel.search')),
          ),
          configured && !editing ? renderFilters() : null,
          body,
          h(
            'footer',
            { className: 'dm-foot' },
            h('span', null, t('panel.tools')),
            h('span', { className: 'dm-tools' }, tools.map((name) => h('code', { key: name, className: 'dm-tool' }, name))),
            h('a', { className: 'dm-foot-link', href: connection?.webHome || webBase, target: '_blank', rel: 'noreferrer noopener' }, t(selfHosted ? 'panel.openInstance' : 'panel.openSite')),
          ),
        )
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, 'en', EN), 'docsmint:locale-en')
        ctx.effect(() => ctx.locale.register(NS, 'ru', RU), 'docsmint:locale-ru')
        const t = ctx.locale.bind(NS)
        const Panel = createPanel(t)

        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: 'docsmint' }, Panel),
        )
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: 'docsmint', order: 20, label: () => t('panel.title') },
            PanelIcon,
          ),
        )
      },
    }
  },
})
