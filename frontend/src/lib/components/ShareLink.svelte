<script lang="ts">
  import * as m from "$lib/paraglide/messages.js";

  let { token = "", expiresAt = "", hasPassword = false, guestEmails = [], onRevoke }: {
    token?: string;
    expiresAt?: string;
    hasPassword?: boolean;
    guestEmails?: string[];
    onRevoke?: () => void;
  } = $props();

  let copied = $state(false);
  let confirmRevoke = $state(false);

  const shareUrl = $derived(`${typeof window !== "undefined" ? window.location.origin : ""}/s/${token}`);

  async function copyLink() {
    await navigator.clipboard.writeText(shareUrl);
    copied = true;
    setTimeout(() => { copied = false; }, 2000);
  }

  function formatExpiry(dateStr: string): string {
    if (!dateStr) return m.share_never_expires();
    const date = new Date(dateStr);
    const now = new Date();
    if (date < now) return m.share_expired_label();
    return m.share_expires_date({ date: date.toLocaleDateString() });
  }

  function removeGuest(_email: string) {
    // placeholder
  }
</script>

<div class="rounded-lg border border-border bg-card p-4">
  <div class="mb-3 flex items-center gap-2">
    <code class="flex-1 truncate text-sm">{shareUrl}</code>
    <button onclick={copyLink} class="rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-accent">
      {copied ? m.share_link_copied() : m.share_copy()}
    </button>
  </div>

  <div class="mb-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
    <span>{formatExpiry(expiresAt)}</span>
    {#if hasPassword}
      <span class="inline-flex items-center gap-1 rounded-md bg-secondary px-2 py-0.5">
        <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
        {m.share_password_label()}
      </span>
    {/if}
  </div>

  {#if guestEmails.length > 0}
    <div class="mb-3 space-y-1">
      <p class="text-xs font-medium text-muted-foreground">{m.share_guests()}</p>
      {#each guestEmails as email}
        <div class="flex items-center justify-between rounded bg-muted px-2 py-1 text-xs">
          <span>{email}</span>
          <button onclick={() => removeGuest(email)} class="text-muted-foreground hover:text-destructive" aria-label={m.attachment_remove()}>&times;</button>
        </div>
      {/each}
    </div>
  {/if}

  {#if !confirmRevoke}
    <button onclick={() => { confirmRevoke = true; }} class="text-xs font-medium text-destructive hover:underline">{m.share_revoke_link()}</button>
  {:else}
    <div class="flex items-center gap-2">
      <span class="text-xs text-destructive">{m.share_revoke_confirm()}</span>
      <button onclick={onRevoke} class="rounded bg-destructive px-2 py-0.5 text-xs font-medium text-destructive-foreground">{m.share_yes()}</button>
      <button onclick={() => { confirmRevoke = false; }} class="rounded border border-border px-2 py-0.5 text-xs">{m.action_cancel()}</button>
    </div>
  {/if}
</div>
