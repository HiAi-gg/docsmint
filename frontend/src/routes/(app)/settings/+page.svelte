<script lang="ts">
import { onMount } from "svelte";
import { goto } from "$app/navigation";
import { deleteAccount, getProfile, updateProfile } from "$lib/api/settings";
import { signOut } from "$lib/auth-client";
import ApiAccessSettings from "$lib/components/settings/ApiAccessSettings.svelte";
import { cleanupOfflineData } from "$lib/offline/cleanup";
import * as m from "$lib/paraglide/messages.js";
import { searchPreferences } from "$lib/stores/search-preferences.svelte";
import { themeStore } from "$lib/stores/theme.svelte";

let loggingOut = $state(false);

async function handleLogout() {
	loggingOut = true;
	try {
		// Wipe cached offline data before ending the session so a shared
		// browser never leaks this user's documents to the next account.
		await cleanupOfflineData();
		await signOut();
		goto("/login");
	} catch {
		loggingOut = false;
	}
}

let activeTab = $state<"profile" | "api" | "danger">("profile");
let saveStatus = $state<"idle" | "saving" | "saved" | "error">("idle");

let name = $state("User");
let email = $state("user@example.com");
let deleteConfirm = $state(false);

onMount(async () => {
	try {
		const profile = await getProfile();
		if (profile.name) name = profile.name;
		if (profile.email) email = profile.email;
	} catch {
		// Use defaults
	}
});

async function saveProfile() {
	saveStatus = "saving";
	try {
		await updateProfile({ name });
		saveStatus = "saved";
		setTimeout(() => {
			saveStatus = "idle";
		}, 2000);
	} catch {
		saveStatus = "error";
	}
}

async function handleDeleteAccount() {
	try {
		await deleteAccount();
		goto("/login");
	} catch {
		alert(m.settings_delete_failed());
	}
}
</script>

<svelte:head>
  <title>{m.settings_page_title()}</title>
</svelte:head>

<div class="mx-auto max-w-2xl p-6">
  <h1 class="mb-6 text-2xl font-semibold">{m.settings_title()}</h1>

  <div class="mb-6 flex gap-1 rounded-lg border border-border p-1">
    {#each [["profile", m.settings_profile()], ["api", "API"], ["danger", m.settings_tab_danger()]] as [key, label]}
      <button
        onclick={() => { activeTab = key as typeof activeTab; }}
        class="flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors
          {activeTab === key ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'}"
      >
        {label}
      </button>
    {/each}
  </div>

  {#if activeTab === "profile"}
    <div class="space-y-4 rounded-lg border border-border bg-card p-6">
      <h2 class="text-lg font-medium">{m.settings_profile()}</h2>
      <div class="space-y-2">
        <label for="name" class="text-sm font-medium">{m.settings_name()}</label>
        <input id="name" bind:value={name} class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" />
      </div>
      <div class="space-y-2">
        <label for="email" class="text-sm font-medium">{m.settings_email()}</label>
        <input id="email" type="email" bind:value={email} class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" disabled />
      </div>
      <div class="flex items-center justify-between gap-4 rounded-md border border-border px-3 py-3">
        <div class="space-y-1">
          <label for="graph-search-enabled" class="text-sm font-medium">GraphRAG search</label>
          <p class="text-xs text-muted-foreground">Use graph expansion to find related documents. Disable it for faster standard RAG search.</p>
        </div>
        <input
          id="graph-search-enabled"
          type="checkbox"
          role="switch"
          class="size-4 shrink-0 accent-primary"
          checked={searchPreferences.graphSearchEnabled}
          onchange={(event) => searchPreferences.update({ graphSearchEnabled: event.currentTarget.checked })}
        />
      </div>
      <div class="flex items-center gap-3">
        <button onclick={saveProfile} disabled={saveStatus === "saving"} class="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
          {saveStatus === "saving" ? m.settings_saving() : saveStatus === "saved" ? m.settings_saved_status() : m.settings_save()}
        </button>
        <button
          id="logout-button"
          onclick={handleLogout}
          disabled={loggingOut}
          class="rounded-md border border-border px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-destructive hover:text-destructive-foreground disabled:opacity-50"
        >
          {loggingOut ? "…" : m.auth_logout()}
        </button>
      </div>
      <p class="text-xs text-muted-foreground">
        Embedding providers are configured by the operator in the
        <a href="https://github.com/HiAi-gg/docsmint/blob/main/docs/DEPLOYMENT.md" class="underline">deployment configuration</a>.
      </p>
    </div>
  {/if}

  {#if activeTab === "api"}
    <ApiAccessSettings />
  {/if}

  {#if activeTab === "danger"}
    <div class="space-y-4 rounded-lg border border-destructive/50 bg-card p-6">
      <h2 class="text-lg font-medium text-destructive">{m.settings_danger_title()}</h2>
      <p class="text-sm text-muted-foreground">{m.settings_danger_description()}</p>
      {#if !deleteConfirm}
        <button onclick={() => { deleteConfirm = true; }} class="rounded-md bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground hover:bg-destructive/90">{m.settings_delete_account()}</button>
      {:else}
        <div class="flex items-center gap-3">
          <span class="text-sm font-medium">{m.settings_delete_confirm_text()}</span>
          <button onclick={handleDeleteAccount} class="rounded-md bg-destructive px-3 py-1.5 text-sm font-medium text-destructive-foreground hover:bg-destructive/90">{m.settings_delete_confirm_yes()}</button>
          <button onclick={() => { deleteConfirm = false; }} class="rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-accent">{m.action_cancel()}</button>
        </div>
      {/if}
    </div>
  {/if}

  <p class="mt-4 text-xs text-muted-foreground">
    {m.settings_theme()}: {themeStore.value} ({themeStore.isDark ? "dark" : "light"})
  </p>
</div>
