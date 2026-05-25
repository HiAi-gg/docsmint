<script lang="ts">
  import { onMount } from "svelte";
  import { getProfile, updateProfile, getEmbeddingConfig, updateEmbeddingConfig, deleteAccount } from "$lib/api/settings";
  import { goto } from "$app/navigation";
  import * as m from "$lib/paraglide/messages.js";

  let activeTab = $state<"profile" | "embedding" | "appearance" | "danger">("profile");
  let saveStatus = $state<"idle" | "saving" | "saved" | "error">("idle");

  let name = $state("User");
  let email = $state("user@example.com");
  let embeddingProvider = $state("ollama");
  let embeddingModel = $state("nomic-embed-text");
  let darkMode = $state(false);
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
    embeddingProvider = config.provider;
    embeddingModel = config.model;

    // Restore dark mode from localStorage
    const saved = localStorage.getItem("theme");
    if (saved === "dark" || (!saved && window.matchMedia("(prefers-color-scheme: dark)").matches)) {
      document.documentElement.classList.add("dark");
    }
    darkMode = document.documentElement.classList.contains("dark");
  });

  function toggleDark() {
    darkMode = !darkMode;
    document.documentElement.classList.toggle("dark", darkMode);
    localStorage.setItem("theme", darkMode ? "dark" : "light");
  }

  async function saveProfile() {
    saveStatus = "saving";
    try {
      await updateProfile({ name, email });
      saveStatus = "saved";
      setTimeout(() => { saveStatus = "idle"; }, 2000);
    } catch {
      saveStatus = "error";
    }
  }

  function saveEmbedding() {
    saveStatus = "saving";
    try {
      updateEmbeddingConfig({ provider: embeddingProvider as "ollama" | "openrouter" | "voyage", model: embeddingModel });
      saveStatus = "saved";
      setTimeout(() => { saveStatus = "idle"; }, 2000);
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
    {#each [["profile", m.settings_profile()], ["embedding", m.settings_tab_embedding()], ["appearance", m.settings_appearance()], ["danger", m.settings_tab_danger()]] as [key, label]}
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
        <input id="email" type="email" bind:value={email} class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" />
      </div>
      <button onclick={saveProfile} disabled={saveStatus === "saving"} class="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
        {saveStatus === "saving" ? m.settings_saving() : saveStatus === "saved" ? m.settings_saved_status() : m.settings_save()}
      </button>
    </div>
  {/if}

  {#if activeTab === "embedding"}
    <div class="space-y-4 rounded-lg border border-border bg-card p-6">
      <h2 class="text-lg font-medium">{m.settings_embedding_title()}</h2>
      <div class="space-y-2">
        <label for="provider" class="text-sm font-medium">{m.settings_embedding_provider()}</label>
        <select id="provider" bind:value={embeddingProvider} class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
          <option value="ollama">{m.settings_embedding_provider_ollama()}</option>
          <option value="openrouter">{m.settings_embedding_provider_openrouter()}</option>
          <option value="voyage">{m.settings_embedding_provider_voyage()}</option>
        </select>
      </div>
      <div class="space-y-2">
        <label for="model" class="text-sm font-medium">{m.settings_embedding_model()}</label>
        <input id="model" bind:value={embeddingModel} placeholder="nomic-embed-text" class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" />
      </div>
      <button onclick={saveEmbedding} disabled={saveStatus === "saving"} class="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
        {saveStatus === "saving" ? m.settings_saving() : saveStatus === "saved" ? m.settings_saved_status() : m.settings_embedding_save()}
      </button>
    </div>
  {/if}

  {#if activeTab === "appearance"}
    <div class="space-y-4 rounded-lg border border-border bg-card p-6">
      <h2 class="text-lg font-medium">{m.settings_appearance()}</h2>
      <div class="flex items-center justify-between">
        <div>
          <p class="text-sm font-medium">{m.settings_dark_mode()}</p>
          <p class="text-xs text-muted-foreground">{m.settings_dark_mode_description()}</p>
        </div>
        <button
          onclick={toggleDark}
          class="relative inline-flex h-5 w-9 items-center rounded-full transition-colors {darkMode ? 'bg-primary' : 'bg-input'}"
          role="switch"
          aria-checked={darkMode}
          aria-label={m.settings_toggle_dark_mode()}
        >
          <span class="inline-block h-4 w-4 rounded-full bg-white shadow transition-transform {darkMode ? 'translate-x-4' : 'translate-x-0.5'}"></span>
        </button>
      </div>
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
</div>
