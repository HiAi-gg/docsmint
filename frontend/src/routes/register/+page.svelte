<script lang="ts">
  import { signUp } from "$lib/auth-client";
  import { goto } from "$app/navigation";
  import * as m from "$lib/paraglide/messages.js";

  let name = $state("");
  let email = $state("");
  let password = $state("");
  let error = $state("");
  let loading = $state(false);

  async function handleSubmit(e: SubmitEvent) {
    e.preventDefault();
    loading = true;
    error = "";

    const result = await signUp.email({
      name,
      email,
      password,
      callbackURL: "/",
    });

    if (result.error) {
      error = result.error.message ?? m.auth_signup_error();
      loading = false;
    } else {
      goto("/");
    }
  }
</script>

<svelte:head>
  <title>{m.register_page_title()}</title>
</svelte:head>

<div class="flex min-h-screen items-center justify-center bg-background">
  <form onsubmit={handleSubmit} class="w-full max-w-sm space-y-4 rounded-lg border border-border bg-card p-6 shadow-sm">
    <div class="space-y-1">
      <h1 class="text-2xl font-semibold tracking-tight">{m.register_title()}</h1>
      <p class="text-sm text-muted-foreground">{m.register_subtitle()}</p>
    </div>

    {#if error}
      <p class="text-sm text-destructive">{error}</p>
    {/if}

    <div class="space-y-2">
      <label for="name" class="text-sm font-medium">{m.settings_name()}</label>
      <input
        id="name"
        type="text"
        bind:value={name}
        required
        class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        placeholder={m.auth_name_placeholder()}
      />
    </div>

    <div class="space-y-2">
      <label for="email" class="text-sm font-medium">{m.auth_email()}</label>
      <input
        id="email"
        type="email"
        bind:value={email}
        required
        class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        placeholder="you@example.com"
      />
    </div>

    <div class="space-y-2">
      <label for="password" class="text-sm font-medium">{m.auth_password()}</label>
      <input
        id="password"
        type="password"
        bind:value={password}
        required
        minlength={8}
        class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        placeholder="••••••••"
      />
    </div>

    <button
      type="submit"
      disabled={loading}
      class="inline-flex h-9 w-full items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow transition-colors hover:bg-primary/90 disabled:opacity-50"
    >
      {loading ? m.register_loading() : m.register_title()}
    </button>

    <p class="text-center text-sm text-muted-foreground">
      {m.auth_has_account()} <a href="/login" class="text-primary underline underline-offset-4 hover:text-primary/80">{m.auth_login()}</a>
    </p>
  </form>
</div>
