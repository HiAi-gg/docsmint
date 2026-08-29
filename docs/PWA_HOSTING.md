# PWA Hosting Guide

This guide describes how to ship DocsMint as an installable Progressive Web App
(PWA). Hosts may provide their own icon set and deployment id.

## Plugin configuration

Use `@vite-pwa/sveltekit` with the `injectManifest` strategy. `SvelteKitPWA()`
must be last in the Vite plugin list and the generated worker is `/sw.js`:

```ts
...SvelteKitPWA({
  registerType: "prompt",
  injectRegister: false,
  strategies: "injectManifest",
  srcDir: "src/pwa",
  filename: "sw.ts",
})
```

With `injectManifest`, precache glob patterns belong under
`injectManifest`, not `workbox`.

## Environment variables

Hosts should set:

- `PUBLIC_APP_ID` — unique app identifier (standalone default: `docsmint`)
- `PUBLIC_DEPLOYMENT_ID` — release identifier for cache/database namespacing
  (local QA: `local`)

Vite-prefixed names remain a local compatibility fallback. The standalone host
is owner-scoped; PWA cache namespaces do not imply multi-tenant server
isolation.

## Service-worker privacy contract

The custom `src/pwa/sw.ts` must:

1. Use `NetworkOnly` for all `/api/*` requests and authenticated navigation.
2. Never place private document HTML, API JSON, auth responses, or mutation
   responses in Cache Storage.
3. Precache only the build shell and explicitly public static assets.
4. Route an offline authenticated navigation to the deterministic
   `/offline.html` shell.
5. Use the required host/deployment cache prefix and clear only that prefix on
   logout or an explicit `CLEAR_HOST_CACHES` message.
6. Accept `SKIP_WAITING` from the in-app update prompt, and skip waiting on
   install so a broken previous shell (404 hashed CSS/JS) can recover.

Document and folder snapshots are stored in identity-partitioned Dexie after a
successful read when offline access is enabled. The service worker itself does
not cache private document content.

## Offline editing contract

Offline mode is cached read plus explicit local drafts:

- opening a cached snapshot is read-only;
- **Create local draft** is an explicit user action;
- draft autosave writes to Dexie and never issues a mutation request;
- reconnect does **not** replay mutations automatically;
- the user must review and explicitly apply a draft with its
  `expectedUpdatedAt` concurrency token;
- a `409 DOCUMENT_CONFLICT` result is resolved by the user.

## Manifest and installability

Override `name`, `short_name`, `theme_color`, and icons in the host manifest.
The plugin injects the manifest link. Add the Apple tags in `app.html`:

```html
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
```

Browsers that emit `beforeinstallprompt` receive an install prompt. iOS Safari
receives an Add to Home Screen instruction. Verify the manifest, active worker,
controller after reload, and `/offline.html` fallback before accepting a host
release.

## CSP and reverse proxy

The host CSP must allow `worker-src 'self'`, `connect-src 'self'`, and
`manifest-src 'self'`. A reverse proxy should keep the worker uncached and
immutable assets long-lived:

```caddyfile
@sw path /sw.js
header @sw Cache-Control "no-cache, no-store, must-revalidate"
@manifest path /manifest.webmanifest
header @manifest Cache-Control "public, max-age=3600"
@immutable path /_app/immutable/*
header @immutable Cache-Control "public, max-age=31536000, immutable"
@images path /pwa-*.png /apple-touch-icon.png /maskable-icon.png
header @images Cache-Control "public, max-age=86400"
```

## Identity and cache boundaries

`OfflineIdentity` resolves `appId` and `deploymentId` from public build
configuration and binds private Dexie data to the verified Better Auth owner.
Cache Storage is host/deployment scoped and contains only public shell/static
assets. It is not user- or tenant-scoped; private identity partitioning belongs
to Dexie. On verified logout, remove the exact Dexie database and host-prefixed
caches before the next account can use the browser.
