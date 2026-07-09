# HiAi Docs PWA Implementation Plan

**Дата:** 2026-07-08

## Цель MVP

Сделать HiAi Docs мобильной PWA с фокусом на:
- установку на телефон;
- mobile-friendly shell;
- быстрый запуск;
- read-only offline-доступ к последним документам;
- безопасную очистку offline-данных при logout;
- сохранение текущего TipTap/Yjs web-стека.

---

## Phase 0 — Подготовка и backup

**0.1** Создать pre-work backup: `scripts/prework_backup.sh hiai-docs`. Если backup не прошёл — не начинать реализацию.

**0.2** Зафиксировать baseline:
- desktop/mobile screenshots;
- Lighthouse Performance, Accessibility, Best Practices, SEO, PWA;
- проверить: login, открытие документа, редактирование, поиск, upload image, collaboration, logout.

**Критерий:** есть baseline и понятно, что улучшилось после PWA.

---

## Phase 1 — PWA зависимости и конфигурация

Добавить:
- `@vite-pwa/sveltekit`
- `workbox-window`
- `dexie`

Обновить `frontend/vite.config.ts`:
- сохранить `tailwindcss()`, `paraglideVitePlugin(...)`, `sveltekit()`;
- добавить `SvelteKitPWA(...)`;
- использовать `generateSW` для MVP.

**Причина:** проще, меньше риска, не нужен кастомный service worker; `injectManifest` оставить на будущую фазу.

**Критерий:** `bun install`, `bun run build` проходят; после build появляются PWA assets / service worker.

---

## Phase 2 — Manifest, icons, mobile meta

В `frontend/static/` добавить:
- `pwa-192x192.png`, `pwa-512x512.png`
- `pwa-maskable-192x192.png`, `pwa-maskable-512x512.png`
- `apple-touch-icon.png`
- `favicon-32x32.png`, `favicon-16x16.png`

> Текущий `favicon.png` около 183KB — для favicon слишком большой.

**Manifest:** `name: HiAi Docs`, `short_name: Docs`, `description`, `start_url: /`, `scope: /`, `display: standalone`, `orientation: portrait-primary`, `theme_color`, `background_color`, `icons` (включая maskable).

В `frontend/src/app.html` добавить:
- `theme-color`
- `apple-mobile-web-app-capable`
- `apple-mobile-web-app-title`
- `apple-mobile-web-app-status-bar-style`
- `apple-touch-icon`

**Критерий:** Chrome DevTools Application Manifest валиден, icons определяются, app installable.

---

## Phase 3 — Service Worker и caching strategy

**App shell caching:** JS/CSS assets, icons, fonts, static images, SvelteKit build assets.
- `CacheFirst` для hashed static assets;
- `StaleWhileRevalidate` для некритичных assets.

**API caching (только GET):**
- `/api/documents`, `/api/documents/:id`, `/api/folders`, `/api/tags`, `/api/categories`, `/api/search`;
- `NetworkFirst` для документов и папок;
- fallback на cache offline;
- короткий TTL для списков;
- более длинный TTL для открытых документов.

**Не кэшировать:**
- `/api/auth/*`, `POST/PATCH/DELETE`, presign/confirm attachments, `/api/admin/*`.

**Offline fallback UI:**
- `frontend/src/routes/offline/+page.svelte` или компонентный fallback в root layout.

**CSP:**
- разделить dev `app.html`, production Caddyfile, backend headers;
- проверить `worker-src`, `manifest-src`, `connect-src`, `wss://`, `blob:`;
- не создавать конфликт двойных CSP в production.

**Критерий:** приложение открывается после offline reload; offline fallback отображается; auth endpoints не кэшируются; service worker обновляется корректно.

---

## Phase 4 — Mobile App Shell

Переделать `frontend/src/routes/(app)/+layout.svelte`:
- desktop: оставить sidebar;
- mobile/tablet: скрыть sidebar;
- добавить top mobile header;
- hamburger button;
- sidebar как Drawer/Sheet overlay.

**Sidebar Drawer** в `frontend/src/lib/components/sidebar/Sidebar.svelte` или wrapper:
- использовать `@hiai-gg/hiai-ui` Sheet/Drawer если есть, иначе bits-ui или Svelte transitions.
- Поведение: `fixed inset-0`, backdrop, panel width `min(88vw, 360px)`;
- close on backdrop / Escape / navigation;
- safe-area support.

**Touch targets:** минимум 44px, лучше 48px:
- sidebar toggle, folder actions, document actions, tag buttons, search clear, editor toolbar, menu buttons.

На mobile отключить sidebar resize и 1px handle.

**Forms polish:**
- login email: `inputmode=email`, `autocomplete=email`;
- login password: `autocomplete=current-password`;
- register password: `autocomplete=new-password`;
- share email: `inputmode=email`.

**Критерий:** на 375px sidebar не съедает экран; nav доступен через hamburger; основные кнопки нажимаются пальцем; login/register удобны.

---

## Phase 5 — Offline read-only через IndexedDB

Добавить **Dexie** слой в `frontend/src/lib/offline/`:
- `db.ts`, `documents-cache.ts`, `folders-cache.ts`, `search-cache.ts`, `network-status.svelte.ts`, `cleanup.ts`, `types.ts`.

**Таблицы:** `documents`, `documentLists`, `folders`, `tags`, `categories`, `searchResults`, `metadata`.

**Поведение:**
- При успешном `GET /api/documents/:id` — сохранить документ в IndexedDB: `timestamp`, `owner/session fingerprint`, `title`, `content`, `contentJson`, `updatedAt`, `tags`, `folder`, `category`.
- При `GET /api/documents` — сохранить список, query params, timestamp.
- Offline fallback в API-клиенте:
  - online: обычный fetch;
  - successful GET: write-through в IndexedDB;
  - offline / network error: попробовать IndexedDB;
  - если нет данных offline: empty state.

> Не делать все API cache-first; backend остаётся источником истины.

**Offline search MVP:** simple local search по `title` / `content` / `tags` / `folder name`; без pgvector offline.

**Критерий:** offline user может открыть dashboard с последним кэшем, открыть последние документы, искать по cached docs, видеть read-only mode.

---

## Phase 6 — Auth, privacy, logout cleanup

**Привязать offline cache к user/session:** metadata хранит `user/session id` или безопасный `fingerprint`, последнюю синхронизацию, `schema version`.

**Очистка при logout:** `frontend/src/lib/components/SettingsDialog.svelte`, `frontend/src/routes/(app)/settings/+page.svelte`, `frontend/src/lib/offline/cleanup.ts`.

Перед / после `signOut()`:
- очистить Dexie database;
- очистить runtime cache при возможности;
- остановить collaboration session;
- сбросить offline state.

**Settings UI:**
- Offline storage used;
- Clear offline data;
- возможно \`Enable offline cache\`.

**Критерий:** после logout offline документы недоступны; другой пользователь не видит чужой cache; IndexedDB очищается.

---

## Phase 7 — WebSocket ws/wss fix

**Файл:** `frontend/src/lib/collaboration.ts`

Сейчас критичный риск: `ws://`. Нужно:
- если `location.protocol === 'https:'` — использовать `wss://`, иначе `ws://`;
- учитывать reverse proxy / Caddy;
- проверить путь `/api/ws/collab/...` или фактический WS route.

**CSP:** dev `ws://localhost:*`, prod `wss://`.

**Критерий:** collaboration работает: local HTTP, production HTTPS, standalone PWA mode.

---

## Phase 8 — Install и Update UX

**InstallPrompt** (`frontend/src/lib/components/pwa/InstallPrompt.svelte`):
- слушать `beforeinstallprompt`;
- показывать ненавязчивый баннер;
- не показывать повторно после dismiss;
- не показывать если app standalone;
- типизировать event без `any`.

**App installed event:** `appinstalled`, скрывать install prompt, можно показывать "App installed".

**UpdatePrompt** (`frontend/src/lib/components/pwa/UpdatePrompt.svelte`) через `workbox-window` или API PWA-плагина:
- "Доступно обновление", "Обновить", `reload` после активации нового SW.

Подключить в `frontend/src/routes/+layout.svelte`: `InstallPrompt`, `UpdatePrompt`, network status indicator.

**Критерий:** install banner работает; update prompt работает; standalone detection работает.

---

## Phase 9 — Performance и editor loading

**Цель:** mobile dashboard/search не должны тащить TipTap bundle.

Проверить route-level split; дополнительно вынести editor-only dependencies. Аккуратно использовать `dynamic import` или `{#await import(...)}` только после проверки SSR compatibility.

**Файлы:**
- `frontend/src/routes/(app)/docs/[id]/+page.svelte`
- `frontend/src/lib/components/editor/HiAiEditor.svelte`

В `vite.config.ts` можно рассмотреть manual chunks: `tiptap`, `yjs`, `ui`, `icons` — только после bundle analysis.

Добавить lightweight **Web Vitals:** LCP, INP, CLS.

**Критерий:** mobile initial load быстрее baseline; editor грузится только на document route; Lighthouse Performance mobile >= 80–85.

---

## Phase 10 — Тесты и верификация

**Unit tests** через Bun:
```
cd projects/hiai-docs/frontend && bun test --path-ignore-patterns="*node_modules*" src/
```
- проверить scripts package.json перед запуском.
- тестировать: offline db helpers, cache cleanup, network fallback, ws/wss URL builder, install prompt state.

**Typecheck:**
```
cd projects/hiai-docs && bun run typecheck
```
или workspace-specific.

**Build:**
```
cd projects/hiai-docs/frontend && bun run build
```
- проверить: service worker generated, manifest generated, static assets copied.

**Browser / Vision verification:** mobile 375px, installability, offline reload, login/logout cleanup, document open offline, collaboration under HTTPS, console errors.

**Lighthouse targets:**
- PWA >= 90 (лучше 100);
- Accessibility >= 95;
- Best Practices >= 90;
- Performance mobile >= 80 (MVP), >=85 (after optimization).

> **Нельзя завершать** без: passing typecheck, passing build, Lighthouse PWA pass, real browser offline test.

---

## Phase 11 — Rollout

**Порядок PR/коммитов:**
1. backup + baseline docs;
2. PWA deps/config;
3. manifest/icons/meta;
4. service worker caching;
5. mobile shell;
6. IndexedDB offline read cache;
7. auth cleanup;
8. ws/wss fix;
9. install/update UX;
10. performance;
11. tests/verification.

**Staging:** HTTPS, Caddy CSP, service worker scope, cache headers, auth cookies, logout cleanup, standalone mode.

**Rollback:** отключить PWA plugin, сбросить service worker registration, bump cache version, показать update/reload prompt.

**Критерий:** PWA можно включить без риска застревания пользователей на старом сломанном service worker.

---

## Recommended implementation order

**MVP 1 — Installable mobile app:**
backup; PWA plugin; manifest/icons/meta; basic service worker; mobile shell; ws/wss fix; install/update prompt; Lighthouse / browser verification.

**MVP 2 — Offline read-only:**
Dexie; documents cache; folders/list cache; offline indicator; offline document view; logout cleanup.

**MVP 3 — Polish:**
local search; performance chunks; Web Vitals; better update UX; settings controls for offline storage.

---

## Do not do in first version

- Offline editing
- Background sync mutations
- Offline Yjs collaboration
- Push notifications
- Custom `injectManifest` service worker
- Semantic search offline
- App Store wrapper

---

## Estimate

| Этап | Срок |
|---|---|
| MVP 1: installable + mobile shell | 2–3 недели |
| MVP 2: offline read-only | 1–2 недели |
| MVP 3: polish / performance | 1 неделя |
| **Total** | **4–6 недель** |
