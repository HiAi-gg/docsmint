<script lang="ts">
import { onMount } from "svelte";
import { goto } from "$app/navigation";
import {
	deleteAccount,
	getEmbeddingConfig,
	getProfile,
	updateEmbeddingConfig,
	updateProfile,
} from "$lib/api/settings";
import { signOut } from "$lib/auth-client";
import ApiAccessSettings from "$lib/components/settings/ApiAccessSettings.svelte";
import * as m from "$lib/paraglide/messages.js";
import { themeStore } from "$lib/stores/theme.svelte";

let loggingOut = $state(false);

async function handleLogout() {
	loggingOut = true;
	try {
		await signOut();
		goto("/login");
	} catch {
		loggingOut = false;
	}
}

let activeTab = $state<"profile" | "api" | "embedding" | "danger">("profile");
let saveStatus = $state<"idle" | "saving" | "saved" | "error">("idle");

let name = $state("User");
let email = $state("user@example.com");
let embeddingBaseUrl = $state("");
let embeddingApiKey = $state("");
let embeddingModel = $state("");
let embeddingFallbackBaseUrl = $state("");
let embeddingFallbackApiKey = $state("");
let embeddingFallbackModel = $state("");
let showFallback = $state(false);
let deleteConfirm = $state(false);

onMount(async () => {
	try {
		const profile = await getProfile();
		if (profile.name) name = profile.name;
		if (profile.email) email = profile.email;
	} catch {
		// Use defaults
	}

	const config = getEmbeddingConfig();
	embeddingBaseUrl = config.baseUrl;
	embeddingApiKey = config.apiKey;
	embeddingModel = config.model;
	embeddingFallbackBaseUrl = config.fallbackBaseUrl ?? "";
	embeddingFallbackApiKey = config.fallbackApiKey ?? "";
	embeddingFallbackModel = config.fallbackModel ?? "";
	showFallback = !!(config.fallbackBaseUrl || config.fallbackModel);
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

function saveEmbedding() {
	saveStatus = "saving";
	try {
		updateEmbeddingConfig({
			baseUrl: embeddingBaseUrl,
			apiKey: embeddingApiKey,
			model: embeddingModel,
			fallbackBaseUrl: embeddingFallbackBaseUrl || null,
			fallbackApiKey: embeddingFallbackApiKey || null,
			fallbackModel: embeddingFallbackModel || null,
		});
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
    {#each [["profile", m.settings_profile()], ["api", "API"], ["embedding", m.settings_tab_embedding()], ["danger", m.settings_tab_danger()]] as [key, label]}
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
    </div>
  {/if}

  {#if activeTab === "api"}
    <ApiAccessSettings />
  {/if}

  {#if activeTab === "embedding"}
    <div class="space-y-4 rounded-lg border border-border bg-card p-6">
      <h2 class="text-lg font-medium">{m.settings_embedding_title()}</h2>
      <div class="space-y-2">
        <label for="embedding-base-url" class="text-sm font-medium">{m.settings_embedding_base_url()}</label>
        <input id="embedding-base-url" bind:value={embeddingBaseUrl} placeholder="https://api.openai.com/v1" class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" />
      </div>
      <div class="space-y-2">
        <label for="embedding-api-key" class="text-sm font-medium">{m.settings_embedding_api_key()}</label>
        <input id="embedding-api-key" type="password" bind:value={embeddingApiKey} placeholder="sk-..." class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" />
      </div>
      <div class="space-y-2">
        <label for="embedding-model" class="text-sm font-medium">{m.settings_embedding_model()}</label>
        <input id="embedding-model" bind:value={embeddingModel} placeholder="text-embedding-3-small" class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" />
      </div>

      <button onclick={() => { showFallback = !showFallback; }} class="text-sm text-muted-foreground hover:text-foreground transition-colors">
        {showFallback ? "− " : "+ "}{m.settings_embedding_fallback_title()}
      </button>

      {#if showFallback}
        <div class="space-y-4 rounded-lg border border-border p-4">
          <div class="space-y-2">
            <label for="embedding-fallback-base-url" class="text-sm font-medium">{m.settings_embedding_fallback_base_url()}</label>
            <input id="embedding-fallback-base-url" bind:value={embeddingFallbackBaseUrl} placeholder="http://localhost:11434" class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" />
          </div>
          <div class="space-y-2">
            <label for="embedding-fallback-api-key" class="text-sm font-medium">{m.settings_embedding_fallback_api_key()}</label>
            <input id="embedding-fallback-api-key" type="password" bind:value={embeddingFallbackApiKey} class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" />
          </div>
          <div class="space-y-2">
            <label for="embedding-fallback-model" class="text-sm font-medium">{m.settings_embedding_fallback_model()}</label>
            <input id="embedding-fallback-model" bind:value={embeddingFallbackModel} placeholder="nomic-embed-text" class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" />
          </div>
        </div>
      {/if}

      <button onclick={saveEmbedding} disabled={saveStatus === "saving"} class="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
        {saveStatus === "saving" ? m.settings_saving() : saveStatus === "saved" ? m.settings_saved_status() : m.settings_embedding_save()}
      </button>
    </div>
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
