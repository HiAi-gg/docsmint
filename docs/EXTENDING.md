# Extending DocsMint

DocsMint exposes additive, typed frontend extension points for self-hosted
customization. Use them to add features without copying a route, sidebar,
dashboard, editor, or authentication flow.

Extensions cannot replace authentication, permissions, retrieval, GraphRAG,
storage, or standard editor behavior. The base application remains the owner of
all document infrastructure and UI flows.

## Public hosts

The public hosts preserve the standalone routes and provide named extension
zones:

| Host | Extensions it consumes | Use it for |
|---|---|---|
| `DocsmintDashboardHost` | `dashboardWidgets` | Custom cards and classification widgets |
| `DocsmintSearchHost` | `searchWidgets` | Custom context next to read-only search state |
| Built-in sidebar | `navigation` | Additional self-hosted navigation links |
| Built-in Settings dialog | `settingsSections` | Custom settings sections |
| Built-in document editor | `editorActions`, `documentTabs` | AI actions and HTML rendition tabs |

Hosts are SvelteKit components. They intentionally use the normal `$app` and
`$lib` runtime, so consume them from a SvelteKit product build rather than a
framework-agnostic widget environment.

## Extension provider

Import from the stable public package path:

```svelte
<script lang="ts">
  import {
    DocsmintExtensionProvider,
  } from "@hiai-gg/docsmint/frontend/extension";
  import { DocsmintDashboardHost } from "@hiai-gg/docsmint/frontend/dashboard";
  import UsageWidget from "./UsageWidget.svelte";

  const extensions = {
    dashboardWidgets: [
      {
        id: "product-usage",
        component: UsageWidget,
        order: 20,
      },
    ],
    navigation: [
      {
        id: "templates",
        label: "Templates",
        href: "/templates",
        order: 20,
      },
    ],
  };
</script>

<DocsmintExtensionProvider {extensions}>
  <DocsmintDashboardHost {data} />
</DocsmintExtensionProvider>
```

The provider creates a request-scoped manifest. With no provider, each host
uses an empty manifest and renders the unchanged standalone DocsMint UI.
Extension ids are deterministic, visibility predicates are isolated, and a
failing visibility predicate is hidden rather than breaking the base UI.

## Editor controls

For a simple typed action, add `editorActions` to the manifest. The action gets
the document id, current Markdown and JSON, selection, and a deliberately small
editor-command facade.

For an existing rich Svelte control such as an AI dropdown or voice input, use
the existing `toolbarExtensions` snippet on `HiAiEditor`. It is additive and
continues to render after the built-in formatting controls.

```svelte
<HiAiEditor bind:content={content} documentId="doc-123">
  {#snippet toolbarExtensions({ editor })}
    <button type="button" onclick={() => editor?.chain().focus().run()}>
      Ask AI
    </button>
  {/snippet}
</HiAiEditor>
```

## Document tabs

Add product tabs through the provider manifest. New integrations must not use
the legacy module-level tab registry; it remains only for existing submodule
consumers.

```svelte
<script lang="ts">
  import { DocsmintExtensionProvider } from "@hiai-gg/docsmint/frontend/extension";
  import HtmlPreviewPanel from "./HtmlPreviewPanel.svelte";
  import CodeIcon from "lucide-svelte/icons/code";

  const extensions = {
    documentTabs: [
      {
        id: "html-preview",
        label: "HTML View",
        component: HtmlPreviewPanel,
        order: 10,
        icon: CodeIcon,
      },
    ],
  };
</script>

<DocsmintExtensionProvider {extensions}>
  {@render children()}
</DocsmintExtensionProvider>
```

Tab panels receive:

```ts
interface DocTabPanelProps {
  documentId: string;
  content: string;
  contentJson: object | undefined;
}
```

## Integration rules

1. Keep extension components and their data outside the core routes.
2. Import only documented public entrypoints, never a private DocsMint route
   or internal store.
3. Use existing DocsMint design tokens and compact accessible controls.
4. Keep Markdown and the structured TipTap JSON equivalent when adding editor
   nodes so sharing and export continue to work.
5. Treat every documented `@hiai-gg/docsmint/frontend/*` subpath as a
   semver-versioned public API; there is intentionally no catch-all barrel.

## Server-only host integration

The packaged backend launcher is available only to Bun server processes:

```ts
import {
  launchDocsmintBackend,
  type DocsmintBackendHandle,
} from "@hiai-gg/docsmint/backend/launcher";

const backend: DocsmintBackendHandle = launchDocsmintBackend({
  env: { API_PORT: "50700" },
});
await backend.ready;
```

The launcher resolves `dist/backend/index.js` inside the installed package,
defensively snapshots the child environment, polls `/api/health`, and sends
`SIGTERM` when startup fails or the host calls `stop()`.

Hosts own storage accounting persistence. Register an adapter whose `reserve`
method atomically checks the current usage and creates an idempotent durable
reservation:

```ts
import {
  createStorageQuotaService,
  type StorageQuotaAdapter,
} from "@hiai-gg/docsmint/storage-quota";

declare const adapter: StorageQuotaAdapter;
const quota = createStorageQuotaService(adapter);
const reservation = await quota.reserve({
  actorUserId,
  requestId,
  idempotencyKey,
  bytes,
});
```

Complete uploads with `quota.commit(...)`; failed or cancelled uploads use
`quota.release(...)`. Adapter operations must be retry-safe. Quota rejection
throws `StorageQuotaExceededError` with the stable code
`STORAGE_QUOTA_EXCEEDED` and non-sensitive byte counts only. Neither server
entrypoint may be imported by browser or frontend bundles.
