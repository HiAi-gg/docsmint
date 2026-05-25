<script lang="ts">
  import { page } from "$app/state";
  import { Lock, FileText, Folder, Copy, Check } from "lucide-svelte";
  import * as m from "$lib/paraglide/messages.js";

  const token = $derived(page.params.token);

  let password = $state("");
  let requiresPassword = $state(false);
  let error = $state("");
  let loading = $state(false);
  let shareData = $state<any>(null);
  let copied = $state(false);

  async function fetchShare() {
    loading = true;
    error = "";
    try {
      const headers: Record<string, string> = {};
      if (password) headers["x-share-password"] = password;

      const res = await fetch(`/api/share/${token}`, { headers });
      const data = await res.json();

      if (res.status === 401 && data.requiresPassword) {
        requiresPassword = true;
        loading = false;
        return;
      }
      if (!res.ok) {
        error = data.error ?? m.share_load_error();
        loading = false;
        return;
      }
      shareData = data;
    } catch (e) {
      error = m.share_network_error();
    }
    loading = false;
  }

  function copyUrl() {
    navigator.clipboard.writeText(window.location.href);
    copied = true;
    setTimeout(() => (copied = false), 2000);
  }

  fetchShare();
</script>

<svelte:head>
  <title>{m.share_page_title()}</title>
</svelte:head>

<div class="flex min-h-screen items-center justify-center bg-background p-4">
  {#if loading}
    <div class="text-muted-foreground">{m.action_loading()}</div>
  {:else if error}
    <div class="w-full max-w-md rounded-lg border border-destructive/50 bg-destructive/10 p-6 text-center">
      <p class="text-lg font-medium text-destructive">{error}</p>
      <a href="/" class="mt-4 inline-block text-sm text-primary underline">{m.share_go_home()}</a>
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
          <h1 class="mb-6 text-3xl font-bold tracking-tight">{shareData.data.title}</h1>
          <div class="prose prose-neutral dark:prose-invert max-w-none">
            {shareData.data.content ?? m.share_empty_document()}
          </div>
        </article>
      {:else}
        <div class="rounded-lg border border-border bg-card p-6 shadow-sm">
          <h1 class="mb-4 text-2xl font-bold">{shareData.data.name}</h1>
          {#if shareData.data.documents.length > 0}
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
  {/if}
</div>
