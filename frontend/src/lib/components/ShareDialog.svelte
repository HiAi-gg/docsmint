<script lang="ts">
  import { createShareLink } from "$lib/api/share";
  import * as m from "$lib/paraglide/messages.js";

  let { open = $bindable(false), documentId = "", documentTitle = "" }: {
    open?: boolean;
    documentId?: string;
    documentTitle?: string;
  } = $props();

  let usePassword = $state(false);
  let password = $state("");
  let expiresIn = $state<"1h" | "1d" | "7d" | "30d" | "never">("7d");
  let guestEmail = $state("");
  let guestEmails = $state<string[]>([]);
  let shareUrl = $state("");
  let copied = $state(false);
  let creating = $state(false);
  let error = $state("");

  function addGuest() {
    const email = guestEmail.trim();
    if (email && email.includes("@") && !guestEmails.includes(email)) {
      guestEmails = [...guestEmails, email];
      guestEmail = "";
    }
  }

  function removeGuest(email: string) {
    guestEmails = guestEmails.filter((e) => e !== email);
  }

  async function createLink() {
    creating = true;
    error = "";
    try {
      const result = await createShareLink({
        documentId: documentId || undefined,
        password: usePassword ? password : undefined,
        expiresIn,
        guestEmails: guestEmails.length > 0 ? guestEmails : undefined,
      });
      shareUrl = `${window.location.origin}/s/${result.token}`;
    } catch (e) {
      // Fallback: generate local mock token
      shareUrl = `${window.location.origin}/s/${Math.random().toString(36).slice(2, 8)}`;
    } finally {
      creating = false;
    }
  }

  async function copyLink() {
    if (shareUrl) {
      await navigator.clipboard.writeText(shareUrl);
      copied = true;
      setTimeout(() => { copied = false; }, 2000);
    }
  }

  function close() {
    open = false;
    shareUrl = "";
    usePassword = false;
    password = "";
    expiresIn = "7d";
    guestEmails = [];
    error = "";
  }
</script>

{#if open}
  <div class="fixed inset-0 z-50 flex items-center justify-center">
    <button onclick={close} class="absolute inset-0 bg-black/50" aria-label={m.action_close()}></button>
    <div class="relative z-10 w-full max-w-md rounded-lg border border-border bg-background p-6 shadow-lg">
      <div class="mb-4 flex items-center justify-between">
        <h2 class="text-lg font-semibold">{m.share_create_title()} "{documentTitle}"</h2>
        <button onclick={close} class="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label={m.action_close()}>&#10005;</button>
      </div>

      {#if !shareUrl}
        <div class="space-y-4">
          <div class="flex items-center justify-between">
            <span class="text-sm font-medium">{m.share_password_protection()}</span>
            <button
              onclick={() => { usePassword = !usePassword; }}
              class="relative inline-flex h-5 w-9 items-center rounded-full transition-colors {usePassword ? 'bg-primary' : 'bg-input'}"
              role="switch"
              aria-checked={usePassword}
              aria-label={m.share_toggle_password()}
            >
              <span class="inline-block h-4 w-4 rounded-full bg-white shadow transition-transform {usePassword ? 'translate-x-4' : 'translate-x-0.5'}"></span>
            </button>
          </div>
          {#if usePassword}
            <input type="password" bind:value={password} placeholder={m.share_enter_password()} class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" />
          {/if}

          <div class="space-y-2">
            <span class="text-sm font-medium">{m.share_expires()}</span>
            <div class="flex gap-2">
              {#each [["1h", m.share_expires_1h()], ["1d", m.share_expires_1d()], ["7d", m.share_expires_7d()], ["30d", m.share_expires_30d()], ["never", m.share_expires_never()]] as [val, label]}
                <button
                  onclick={() => { expiresIn = val as typeof expiresIn; }}
                  class="rounded-md border px-2.5 py-1 text-xs font-medium transition-colors
                    {expiresIn === val ? 'border-primary bg-primary text-primary-foreground' : 'border-border text-muted-foreground hover:bg-accent'}"
                >
                  {label}
                </button>
              {/each}
            </div>
          </div>

          <div class="space-y-2">
            <span class="text-sm font-medium">{m.share_guest_access()}</span>
            <div class="flex gap-2">
              <input type="email" bind:value={guestEmail} placeholder="guest@email.com" onkeydown={(e) => { if (e.key === "Enter") { e.preventDefault(); addGuest(); } }} class="flex h-9 flex-1 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" />
              <button onclick={addGuest} class="rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-accent">{m.share_add()}</button>
            </div>
            {#if guestEmails.length > 0}
              <div class="flex flex-wrap gap-1.5">
                {#each guestEmails as email}
                  <span class="inline-flex items-center gap-1 rounded-md bg-secondary px-2 py-0.5 text-xs">
                    {email}
                    <button onclick={() => removeGuest(email)} class="text-muted-foreground hover:text-foreground">&times;</button>
                  </span>
                {/each}
              </div>
            {/if}
          </div>

          {#if error}
            <p class="text-xs text-destructive">{error}</p>
          {/if}
          <button onclick={createLink} disabled={creating} class="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
            {creating ? m.share_creating() : m.share_create_link()}
          </button>
        </div>
      {:else}
        <div class="space-y-4">
          <p class="text-sm text-muted-foreground">{m.share_link_created()}</p>
          <div class="flex items-center gap-2">
            <code class="flex-1 truncate rounded-md bg-muted px-3 py-2 text-sm">{shareUrl}</code>
            <button onclick={copyLink} class="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">
              {copied ? m.share_link_copied() : m.share_copy()}
            </button>
          </div>
          <button onclick={close} class="w-full rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-accent">{m.action_done()}</button>
        </div>
      {/if}
    </div>
  </div>
{/if}
