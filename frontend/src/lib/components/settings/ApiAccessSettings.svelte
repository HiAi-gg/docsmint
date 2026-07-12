<script lang="ts">
import { Button } from "@hiai-gg/hiai-ui/components/ui/button";
import { Input } from "@hiai-gg/hiai-ui/components/ui/input";
import { onMount } from "svelte";
import {
	type ApiKeySummary,
	apiKeyClipboardValue,
	categoryIdFromScopes,
	createGlobalApiKey,
	listApiKeys,
	revealCategoryApiKey,
	revokeApiKey,
} from "$lib/api/api-keys";
import { type Category, listCategories } from "$lib/api/categories";

let keys = $state<ApiKeySummary[]>([]);
let categories = $state<Category[]>([]);
let keyName = $state("Global API key");
let issuedKeys = $state<Record<string, string>>({});
let latestIssuedId = $state<string | null>(null);
let loading = $state(true);
let busy = $state(false);
let error = $state<string | null>(null);
const latestIssuedKey = $derived(
	latestIssuedId ? issuedKeys[latestIssuedId] : undefined,
);

const globalKeys = $derived(
	keys.filter((key) => key.scopes.includes("global")),
);
const categoryKeys = $derived(
	keys.filter((key) => categoryIdFromScopes(key.scopes) !== null),
);

function categoryName(id: string | null): string {
	return (
		categories.find((category) => category.id === id)?.name ??
		"Unknown category"
	);
}

async function refresh() {
	loading = true;
	error = null;
	try {
		const [keyResult, categoryResult] = await Promise.all([
			listApiKeys(),
			listCategories(),
		]);
		keys = keyResult.keys;
		categories = categoryResult;
	} catch (err) {
		error = err instanceof Error ? err.message : "Failed to load API access";
	} finally {
		loading = false;
	}
}

onMount(refresh);

async function issueGlobalKey() {
	busy = true;
	error = null;
	try {
		const issued = await createGlobalApiKey(keyName.trim() || undefined);
		issuedKeys = { ...issuedKeys, [issued.id]: issued.key };
		latestIssuedId = issued.id;
		await refresh();
	} catch (err) {
		error = err instanceof Error ? err.message : "Failed to create API key";
	} finally {
		busy = false;
	}
}

async function revoke(id: string) {
	busy = true;
	try {
		await revokeApiKey(id);
		const { [id]: _revoked, ...remainingIssuedKeys } = issuedKeys;
		issuedKeys = remainingIssuedKeys;
		if (latestIssuedId === id) latestIssuedId = null;
		await refresh();
	} finally {
		busy = false;
	}
}

async function copyKey(key: ApiKeySummary) {
	const rawKey = issuedKeys[key.id] ?? (await revealCategoryApiKey(key.id));
	await navigator.clipboard.writeText(apiKeyClipboardValue(key, rawKey));
}
</script>

<div class="space-y-5 rounded-lg border border-border bg-card p-6">
	<div>
		<h2 class="text-lg font-medium">API</h2>
		<p class="text-sm text-muted-foreground">Create a user-wide key or review category-scoped access. Global keys are shown once.</p>
	</div>
	<div class="flex gap-2">
		<Input aria-label="Global API key name" bind:value={keyName} />
		<Button onclick={issueGlobalKey} disabled={busy}>Create global key</Button>
	</div>
	{#if latestIssuedKey}
		<div class="rounded-lg border border-primary/30 bg-primary/10 p-4 text-primary">
			<p class="text-sm font-medium">Copy this key now. It will not be shown again.</p>
			<code class="mt-2 block break-all rounded bg-background/80 p-2 text-xs text-foreground">{latestIssuedKey}</code>
			<Button class="mt-2" size="sm" variant="outline" onclick={() => navigator.clipboard.writeText(latestIssuedKey)}>Copy key</Button>
		</div>
	{/if}
	{#if error}<p class="text-sm text-destructive" role="alert">{error}</p>{/if}
	{#if loading}
		<p class="text-sm text-muted-foreground">Loading API access…</p>
	{:else}
		<div
			class="max-h-72 space-y-5 overflow-y-auto pr-1"
			aria-label="API key management list"
		>
			<section class="space-y-2">
				<h3 class="text-sm font-semibold">Global keys</h3>
				{#each globalKeys as key (key.id)}
					<div class="flex items-center justify-between rounded-md border p-3 text-sm">
						<div><div class="font-medium">{key.name}</div><div class="text-muted-foreground">{key.prefix}…</div></div>
						<Button size="sm" variant="destructive" onclick={() => revoke(key.id)} disabled={busy}>Revoke</Button>
					</div>
				{:else}<p class="text-sm text-muted-foreground">No global API keys.</p>{/each}
			</section>
			<section class="space-y-2">
				<h3 class="text-sm font-semibold">Category keys</h3>
				{#each categoryKeys as key (key.id)}
					<div class="flex items-center justify-between gap-3 rounded-md border border-dashed p-3 text-sm">
						<div><div class="font-medium">{categoryName(categoryIdFromScopes(key.scopes))}: {key.name}</div><div class="text-muted-foreground">{key.prefix}… · {key.scopes.map((scope) => scope.split(":").at(-1)).join(" / ")}</div></div>
						<div class="flex shrink-0 gap-2">
							<Button size="sm" variant="outline" onclick={() => copyKey(key)} disabled={!key.recoverable && !issuedKeys[key.id]}>{key.recoverable || issuedKeys[key.id] ? "Copy key" : "Rotate to enable copy"}</Button>
							<Button size="sm" variant="destructive" onclick={() => revoke(key.id)} disabled={busy}>Revoke</Button>
						</div>
					</div>
				{:else}<p class="text-sm text-muted-foreground">No category API keys.</p>{/each}
			</section>
		</div>
	{/if}
</div>
