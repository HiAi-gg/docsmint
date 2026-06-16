<script lang="ts">
import { Check, Copy, FileText, Folder, Lock } from "lucide-svelte";
import { marked } from "marked";
import { page } from "$app/state";
import * as m from "$lib/paraglide/messages.js";

const token = $derived(page.params.token);

let password = $state("");
let requiresPassword = $state(false);
let error = $state("");
let loading = $state(false);
let shareData = $state<{
	type?: string;
	data?: {
		title?: string;
		content?: string;
		contentTipex?: object | null;
		name?: string;
		documents?: { title: string }[];
	};
} | null>(null);
let copied = $state(false);

// SvelteKit-injected fetch avoids the `window.fetch` warning during SSR/CSR
// transitions. Falls back to global fetch when running outside a load fn
// (e.g. in unit tests).
const kitFetch = $derived(
	(page.data.fetch as typeof fetch | undefined) ?? globalThis.fetch,
);

// Configure marked for safe, GFM-flavored rendering of shared document
// markdown. The TipexEditor JSON path (contentTipex) is preferred when the
// server provides it, but `content` (raw markdown) is the universal fallback.
marked.setOptions({ gfm: true, breaks: false });

function renderContent(): string {
	if (!shareData?.data) return "";
	const tipex = shareData.data.contentTipex as
		| { content?: unknown }
		| null
		| undefined;
	if (tipex && Array.isArray(tipex.content)) {
		return tipexToHtml(tipex as ProseMirrorDoc);
	}
	const md = shareData.data.content;
	if (md && md.length > 0) {
		return marked.parse(md, { async: false }) as string;
	}
	return "";
}

type ProseMirrorNode = {
	type: string;
	text?: string;
	content?: ProseMirrorNode[];
	attrs?: Record<string, unknown>;
	marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
};

type ProseMirrorDoc = ProseMirrorNode & { content?: ProseMirrorNode[] };

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function tipexToHtml(doc: ProseMirrorDoc): string {
	const renderNode = (node: ProseMirrorNode): string => {
		if (node.type === "text") {
			let html = escapeHtml(node.text ?? "");
			for (const mark of node.marks ?? []) {
				html = wrapMark(mark, html);
			}
			return html;
		}
		const inner = (node.content ?? []).map(renderNode).join("");
		return wrapBlock(node, inner);
	};
	return (doc.content ?? []).map(renderNode).join("");
}

function wrapMark(
	mark: { type: string; attrs?: Record<string, unknown> },
	html: string,
): string {
	switch (mark.type) {
		case "bold":
			return `<strong>${html}</strong>`;
		case "italic":
			return `<em>${html}</em>`;
		case "strike":
		case "strikethrough":
			return `<s>${html}</s>`;
		case "underline":
			return `<u>${html}</u>`;
		case "code":
			return `<code>${html}</code>`;
		case "link": {
			const href = (mark.attrs?.href as string) ?? "#";
			return `<a href="${escapeHtml(href)}" rel="noopener noreferrer">${html}</a>`;
		}
		case "highlight": {
			const color = (mark.attrs?.color as string) ?? "#fde68a";
			return `<mark style="background-color: ${escapeHtml(color)}">${html}</mark>`;
		}
		default:
			return html;
	}
}

function wrapBlock(node: ProseMirrorNode, inner: string): string {
	const lang = (node.attrs?.language as string) ?? "";
	switch (node.type) {
		case "paragraph":
			return `<p>${inner}</p>`;
		case "heading": {
			const level = Math.min(Math.max(Number(node.attrs?.level ?? 1), 1), 6);
			return `<h${level}>${inner}</h${level}>`;
		}
		case "bulletList":
			return `<ul>${inner}</ul>`;
		case "orderedList":
			return `<ol>${inner}</ol>`;
		case "listItem":
			return `<li>${inner}</li>`;
		case "blockquote":
			return `<blockquote>${inner}</blockquote>`;
		case "codeBlock":
			return `<pre><code${lang ? ` class="language-${escapeHtml(lang)}"` : ""}>${inner}</code></pre>`;
		case "horizontalRule":
			return `<hr />`;
		case "hardBreak":
			return `<br />`;
		case "image": {
			const src = (node.attrs?.src as string) ?? "";
			const alt = (node.attrs?.alt as string) ?? "";
			return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" />`;
		}
		default:
			return inner;
	}
}

const renderedContent = $derived(renderContent());

async function fetchShare() {
	loading = true;
	try {
		const headers: Record<string, string> = {};
		if (password) headers["x-share-password"] = password;

		const res = await kitFetch(`/api/share/${token}`, { headers });
		const data = await res.json();

		if (res.status === 401) {
			// Server signals the share is password-protected when `requiresPassword`
			// is true on the response (initial load with no password supplied).
			// A wrong password comes back as 401 without that flag — we must keep
			// the password form visible and surface a retryable inline error
			// instead of replacing the whole view with a fatal error banner.
			requiresPassword = true;
			password = "";
			error = data.requiresPassword ? "" : m.share_password_incorrect();
			return;
		}
		if (!res.ok) {
			// Non-password failure (expired, missing share, server error). Drop
			// the password form so the user sees the banner with a way home.
			requiresPassword = false;
			password = "";
			error = data.error ?? m.share_load_error();
			return;
		}
		// Success — clear transient auth state so the document view renders.
		shareData = data;
		requiresPassword = false;
		password = "";
		error = "";
	} catch (_e) {
		requiresPassword = false;
		password = "";
		error = m.share_network_error();
	} finally {
		loading = false;
	}
}

function copyUrl() {
	navigator.clipboard.writeText(window.location.href);
	copied = true;
	setTimeout(() => {
		copied = false;
	}, 2000);
}

fetchShare();
</script>

<svelte:head>
  <title>{m.share_page_title()}</title>
</svelte:head>

<div class="flex min-h-screen items-center justify-center bg-background p-4">
  {#if loading}
    <div class="text-muted-foreground">{m.action_loading()}</div>
  {:else if shareData}
    <div class="w-full max-w-3xl space-y-6">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2 text-sm text-muted-foreground">
          {#if shareData.type === "document"}
            <FileText class="h-4 w-4" />
          {:else}
            <Folder class="h-4 w-4" />
          {/if}
          {m.share_via_label()}
        </div>
        <button
          onclick={copyUrl}
          class="flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent"
        >
          {#if copied}
            <Check class="h-3 w-3" /> {m.share_copied()}
          {:else}
            <Copy class="h-3 w-3" /> {m.share_copy_link()}
          {/if}
        </button>
      </div>

      {#if shareData.type === "document"}
        <article class="rounded-lg border border-border bg-card p-8 shadow-sm">
          <h1 class="mb-6 text-3xl font-bold tracking-tight">{shareData.data?.title ?? ""}</h1>
          {#if renderedContent}
            <div class="shared-doc-body">
              {@html renderedContent}
            </div>
          {:else}
            <p class="text-muted-foreground">{m.share_empty_document()}</p>
          {/if}
        </article>
      {:else}
        <div class="rounded-lg border border-border bg-card p-6 shadow-sm">
          <h1 class="mb-4 text-2xl font-bold">{shareData.data?.name ?? ""}</h1>
          {#if shareData.data?.documents && shareData.data.documents.length > 0}
            <ul class="space-y-2">
              {#each shareData.data.documents as doc}
                <li class="flex items-center gap-2 rounded-md border border-border px-3 py-2">
                  <FileText class="h-4 w-4 text-muted-foreground" />
                  <span>{doc.title}</span>
                </li>
              {/each}
            </ul>
          {:else}
            <p class="text-muted-foreground">{m.share_folder_empty()}</p>
          {/if}
        </div>
      {/if}
    </div>
  {:else if requiresPassword}
    <form
      onsubmit={(e) => { e.preventDefault(); fetchShare(); }}
      class="w-full max-w-sm space-y-4 rounded-lg border border-border bg-card p-6 shadow-sm"
    >
      <div class="flex items-center gap-2 text-lg font-semibold">
        <Lock class="h-5 w-5" />
        {m.share_password_required()}
      </div>
      {#if error}
        <div
          role="alert"
          class="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </div>
      {/if}
      <input
        type="password"
        bind:value={password}
        placeholder={m.share_password_placeholder()}
        class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <button
        type="submit"
        class="inline-flex h-9 w-full items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow hover:bg-primary/90"
      >
        {m.share_access_button()}
      </button>
    </form>
  {:else if error}
    <div class="w-full max-w-md rounded-lg border border-destructive/50 bg-destructive/10 p-6 text-center">
      <p class="text-lg font-medium text-destructive">{error}</p>
      <a href="/" class="mt-4 inline-block text-sm text-primary underline">{m.share_go_home()}</a>
    </div>
  {/if}
</div>

<style>
  /* Shared document body — minimal styles for the markdown/JSON HTML output
     rendered via {@html}. The `prose` class from @tailwindcss/typography
     is not installed in this project, so we provide the essentials. */
  .shared-doc-body {
    color: var(--foreground);
    line-height: 1.7;
    font-size: 1rem;
    word-wrap: break-word;
  }
  .shared-doc-body :global(h1) {
    font-size: 1.875rem;
    font-weight: 700;
    margin: 1.5rem 0 0.75rem;
    letter-spacing: -0.02em;
  }
  .shared-doc-body :global(h2) {
    font-size: 1.5rem;
    font-weight: 700;
    margin: 1.25rem 0 0.5rem;
  }
  .shared-doc-body :global(h3) {
    font-size: 1.25rem;
    font-weight: 600;
    margin: 1rem 0 0.5rem;
  }
  .shared-doc-body :global(p) {
    margin: 0.5rem 0;
  }
  .shared-doc-body :global(ul),
  .shared-doc-body :global(ol) {
    padding-left: 1.5rem;
    margin: 0.5rem 0;
  }
  .shared-doc-body :global(ul) {
    list-style-type: disc;
  }
  .shared-doc-body :global(ol) {
    list-style-type: decimal;
  }
  .shared-doc-body :global(li) {
    margin: 0.25rem 0;
  }
  .shared-doc-body :global(blockquote) {
    border-left: 3px solid var(--border);
    padding-left: 1rem;
    margin: 0.75rem 0;
    color: var(--muted-foreground);
    font-style: italic;
  }
  .shared-doc-body :global(code) {
    background: var(--muted);
    padding: 0.125rem 0.375rem;
    border-radius: 4px;
    font-size: 0.875em;
    font-family: "Fira Code", "Consolas", monospace;
  }
  .shared-doc-body :global(pre) {
    background: var(--muted);
    color: var(--foreground);
    padding: 1rem;
    border-radius: 8px;
    font-family: "Fira Code", "Consolas", monospace;
    font-size: 0.875rem;
    line-height: 1.6;
    overflow-x: auto;
    margin: 0.75rem 0;
  }
  .shared-doc-body :global(pre code) {
    background: transparent;
    padding: 0;
    font-size: inherit;
    color: inherit;
  }
  .shared-doc-body :global(hr) {
    border: none;
    border-top: 1px solid var(--border);
    margin: 1.5rem 0;
  }
  .shared-doc-body :global(a) {
    color: var(--primary);
    text-decoration: underline;
  }
  .shared-doc-body :global(img) {
    max-width: 100%;
    height: auto;
    border-radius: 6px;
    margin: 0.75rem 0;
    display: block;
  }
  .shared-doc-body :global(mark) {
    background-color: var(--highlight-default, #fde68a);
    border-radius: 2px;
    padding: 0 2px;
  }
</style>
