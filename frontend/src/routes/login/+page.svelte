<script lang="ts">
import { browser } from "$app/environment";
import { goto } from "$app/navigation";
import { signIn } from "$lib/auth-client";
import * as m from "$lib/paraglide/messages.js";

let email = $state("");
let password = $state("");
let error = $state("");
let loading = $state(false);

const LOGIN_TIMEOUT_MS = 15_000;

async function handleSubmit(e: SubmitEvent) {
	e.preventDefault();
	loading = true;
	error = "";
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), LOGIN_TIMEOUT_MS);

	try {
		const result = await signIn.email(
			{
				email,
				password,
				callbackURL: "/",
			},
			{ signal: controller.signal },
		);

		if (result.error) {
			error = result.error.message ?? m.auth_login_error();
			return;
		}

		await goto("/");
	} catch {
		error = controller.signal.aborted ? m.error_timeout() : m.error_network();
	} finally {
		clearTimeout(timeout);
		loading = false;
	}
}
</script>

<svelte:head>
	<title>{m.login_page_title()}</title>
</svelte:head>

<div class="flex min-h-screen items-center justify-center bg-background">
	{#if browser}
		<form
			onsubmit={handleSubmit}
			class="w-full max-w-sm space-y-4 rounded-lg border border-border bg-card p-6 shadow-sm"
		>
			<div class="space-y-2">
				<div class="flex items-center gap-2">
					<img src="/logo.png" alt="HiAi-Docs" class="h-8 w-auto dark:invert" />
					<h1 class="text-2xl font-semibold tracking-tight">{m.login_title()}</h1>
				</div>
				<p class="text-sm text-muted-foreground">{m.login_subtitle()}</p>
			</div>

			{#if error}
				<p class="text-sm text-destructive">{error}</p>
			{/if}

			<div class="space-y-2">
				<label for="email" class="text-sm font-medium">{m.auth_email()}</label>
				<input
					id="email"
					type="email"
					bind:value={email}
					required
					autocomplete="off"
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
					autocomplete="new-password"
					class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
					placeholder="••••••••"
				/>
			</div>

			<button
				type="submit"
				disabled={loading}
				class="inline-flex h-9 w-full items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow transition-colors hover:bg-primary/90 disabled:opacity-50"
			>
				{loading ? m.login_loading() : m.login_submit()}
			</button>

			<p class="text-center text-sm text-muted-foreground">
				{m.auth_no_account()} <a href="/register" class="text-primary underline underline-offset-4 hover:text-primary/80"
					>{m.register_title()}</a
				>
			</p>
		</form>
	{:else}
		<!-- SSR placeholder -->
		<div class="w-full max-w-sm space-y-4 rounded-lg border border-border bg-card p-6 shadow-sm">
			<div class="space-y-2">
				<div class="flex items-center gap-2">
					<div class="h-8 w-8 rounded bg-muted"></div>
					<div class="h-8 w-32 rounded bg-muted"></div>
				</div>
				<div class="h-4 w-48 rounded bg-muted"></div>
			</div>
			<div class="space-y-2">
				<div class="h-4 w-16 rounded bg-muted"></div>
				<div class="h-9 w-full rounded bg-muted"></div>
			</div>
			<div class="space-y-2">
				<div class="h-4 w-20 rounded bg-muted"></div>
				<div class="h-9 w-full rounded bg-muted"></div>
			</div>
			<div class="h-9 w-full rounded bg-primary/50"></div>
			<div class="h-4 w-48 mx-auto rounded bg-muted"></div>
		</div>
	{/if}
</div>
