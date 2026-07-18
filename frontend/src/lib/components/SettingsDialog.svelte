<script lang="ts">
import { Button } from "@hiai-gg/hiai-ui/components/ui/button";
import * as Dialog from "@hiai-gg/hiai-ui/components/ui/dialog";
import { Input } from "@hiai-gg/hiai-ui/components/ui/input";
import { Label } from "@hiai-gg/hiai-ui/components/ui/label";
import * as Tabs from "@hiai-gg/hiai-ui/components/ui/tabs";
import { Loader2, LogOut, Save } from "lucide-svelte";
import { onMount } from "svelte";
import { goto } from "$app/navigation";
import { page } from "$app/state";
import { getProfile, updateProfile } from "$lib/api/settings";
import { authClient, signOut } from "$lib/auth-client";
import ApiAccessSettings from "$lib/components/settings/ApiAccessSettings.svelte";
import { getFrontendExtensions } from "$lib/extensions/context";
import { resolveExtensions } from "$lib/extensions/resolve";
import { cleanupOfflineData } from "$lib/offline/cleanup";
import * as m from "$lib/paraglide/messages.js";
import { editorPreferences } from "$lib/stores/editor-preferences.svelte";
import { searchPreferences } from "$lib/stores/search-preferences.svelte";
import { type Theme, themeStore } from "$lib/stores/theme.svelte";

let {
	open = $bindable(false),
}: {
	open?: boolean;
} = $props();

let activeTab = $state("profile");
const frontendExtensions = getFrontendExtensions();
const settingsExtensions = $derived(
	resolveExtensions(frontendExtensions.settingsSections, {
		pathname: page.url.pathname,
	}),
);

// Profile
let name = $state("");
let email = $state("");
let currentEmail = $state("");
let pendingEmail = $state("");
let profileStatus = $state<"idle" | "saving" | "saved" | "error">("idle");
let profileError = $state("");

// Password
let currentPassword = $state("");
let newPassword = $state("");
let confirmPassword = $state("");
let passwordStatus = $state<"idle" | "saving" | "saved" | "error">("idle");
let passwordError = $state("");

onMount(async () => {
	editorPreferences.init();
	searchPreferences.init();
	try {
		const profile = await getProfile();
		if (profile.name) name = profile.name;
		if (profile.email) {
			email = profile.email;
			currentEmail = profile.email;
		}
	} catch {
		// use defaults
	}
});

async function saveProfile() {
	profileStatus = "saving";
	profileError = "";
	try {
		await updateProfile({ name });
		if (
			email.trim() !== "" &&
			email.trim().toLowerCase() !== currentEmail.toLowerCase()
		) {
			const { error } = await authClient.changeEmail({
				newEmail: email.trim(),
				callbackURL: "/",
			});
			if (error) throw new Error(error.message ?? m.error_generic());
			pendingEmail = email.trim();
		}
		profileStatus = "saved";
		setTimeout(() => {
			profileStatus = "idle";
		}, 2000);
	} catch (e) {
		profileStatus = "error";
		profileError = e instanceof Error ? e.message : m.error_document_save();
	}
}

async function changePassword() {
	passwordError = "";
	if (newPassword !== confirmPassword) {
		passwordStatus = "error";
		passwordError = m.auth_password_mismatch();
		return;
	}
	if (newPassword.length < 8) {
		passwordStatus = "error";
		passwordError = m.auth_password_min();
		return;
	}
	passwordStatus = "saving";
	try {
		// Better Auth exposes a dedicated change-password endpoint
		// (POST /api/auth/change-password) that requires `currentPassword` and
		// `newPassword`. The previous `update-user` route is for profile fields
		// (name/email) and rejected this body with 400. revokeOtherSessions
		// invalidates any other active sessions for this user.
		const { error } = await authClient.changePassword({
			currentPassword,
			newPassword,
			revokeOtherSessions: true,
		});
		if (error) {
			passwordStatus = "error";
			passwordError = error.message ?? m.error_generic();
			return;
		}
		passwordStatus = "saved";
		currentPassword = "";
		newPassword = "";
		confirmPassword = "";
		setTimeout(() => {
			passwordStatus = "idle";
		}, 2000);
	} catch (e) {
		passwordStatus = "error";
		passwordError = e instanceof Error ? e.message : m.error_generic();
	}
}

function pickTheme(value: Theme) {
	themeStore.set(value);
}

const themeOptions: Array<{ value: Theme; label: string; key: string }> = [
	{ value: "light", label: m.theme_light(), key: "light" },
	{ value: "dark", label: m.theme_dark(), key: "dark" },
	{ value: "system", label: m.theme_system(), key: "system" },
];

let loggingOut = $state(false);

async function handleLogout() {
	loggingOut = true;
	try {
		// Wipe cached offline data before ending the session so a shared
		// browser never leaks this user's documents to the next account.
		await cleanupOfflineData();
		await signOut();
		open = false;
		goto("/login");
	} catch {
		loggingOut = false;
	}
}

function close() {
	open = false;
}
</script>

<Dialog.Dialog bind:open>
	<Dialog.DialogHeader>
		<Dialog.DialogTitle>{m.settings_title()}</Dialog.DialogTitle>
		<Dialog.DialogDescription>
			{m.settings_account()}
		</Dialog.DialogDescription>
	</Dialog.DialogHeader>

	<Tabs.Tabs bind:value={activeTab} class="w-full">
		<Tabs.TabsList
			class="grid w-full grid-cols-[repeat(auto-fit,minmax(0,1fr))] gap-1"
		>
			<Tabs.TabsTrigger
				value="profile"
				selected={activeTab === "profile"}
				onclick={(v) => (activeTab = v)}
			>
				{m.settings_profile()}
			</Tabs.TabsTrigger>
			<Tabs.TabsTrigger
				value="password"
				selected={activeTab === "password"}
				onclick={(v) => (activeTab = v)}
			>
				{m.password_label()}
			</Tabs.TabsTrigger>
			<Tabs.TabsTrigger
				value="api"
				selected={activeTab === "api"}
				onclick={(v) => (activeTab = v)}
			>
				API
			</Tabs.TabsTrigger>
			<Tabs.TabsTrigger
				value="appearance"
				selected={activeTab === "appearance"}
				onclick={(v) => (activeTab = v)}
			>
				Style
			</Tabs.TabsTrigger>
			{#each settingsExtensions as section (section.id)}
				<Tabs.TabsTrigger
					value={section.id}
					selected={activeTab === section.id}
					onclick={(value) => (activeTab = value)}
				>
					{section.label}
				</Tabs.TabsTrigger>
			{/each}
		</Tabs.TabsList>

		<Tabs.TabsContent value="profile" currentValue={activeTab}>
			<form onsubmit={(e) => { e.preventDefault(); saveProfile(); }} class="space-y-4">
				<div class="space-y-2">
					<Label for="settings-name">{m.settings_name()}</Label>
					<Input id="settings-name" type="text" name="name" bind:value={name} autocomplete="name" />
				</div>
				<div class="space-y-2">
					<Label for="settings-email">{m.settings_email()}</Label>
			<Input id="settings-email" type="email" name="email" bind:value={email} autocomplete="email" />
			<p class="text-xs text-muted-foreground">{m.settings_email_change_warning()}</p>
			{#if pendingEmail}
				<p class="text-xs text-muted-foreground">Verification is required before the new address becomes active.</p>
			{/if}
				</div>
				<div class="flex items-center justify-between gap-4 rounded-md border p-3">
					<span>
						<span class="block text-sm font-medium">GraphRAG search</span>
						<span class="block text-xs text-muted-foreground">Use graph expansion for related documents. Disable it for faster standard RAG search.</span>
					</span>
					<button
						type="button"
						role="switch"
						class="preference-switch"
						class:enabled={searchPreferences.graphSearchEnabled}
						aria-checked={searchPreferences.graphSearchEnabled}
						aria-label="Use GraphRAG search"
						onclick={() => searchPreferences.update({ graphSearchEnabled: !searchPreferences.graphSearchEnabled })}
					><span></span></button>
				</div>
				{#if profileError}
					<p class="text-sm text-destructive">{profileError}</p>
				{/if}
				<Button type="submit" disabled={profileStatus === "saving"} class="w-full sm:w-auto">
					{#if profileStatus === "saving"}
						<Loader2 class="mr-2 size-4 animate-spin" />
					{:else}
						<Save class="mr-2 size-4" />
					{/if}
					{profileStatus === "saved" ? m.settings_saved_status() : m.settings_save()}
				</Button>
			</form>
		</Tabs.TabsContent>

		<Tabs.TabsContent value="password" currentValue={activeTab}>
			<form onsubmit={(e) => { e.preventDefault(); changePassword(); }} class="space-y-4">
				<div class="space-y-2">
					<Label for="settings-current-password">{m.auth_password()}</Label>
					<Input
						id="settings-current-password"
						type="password"
						name="current-password"
						bind:value={currentPassword}
						autocomplete="current-password"
					/>
				</div>
				<div class="space-y-2">
					<Label for="settings-new-password">{m.new_password()}</Label>
					<Input
						id="settings-new-password"
						type="password"
						name="new-password"
						bind:value={newPassword}
						autocomplete="new-password"
					/>
				</div>
				<div class="space-y-2">
					<Label for="settings-confirm-password">{m.confirm_password()}</Label>
					<Input
						id="settings-confirm-password"
						type="password"
						name="confirm-password"
						bind:value={confirmPassword}
						autocomplete="new-password"
					/>
				</div>
				{#if passwordError}
					<p class="text-sm text-destructive">{passwordError}</p>
				{/if}
				<Button type="submit" disabled={passwordStatus === "saving"} class="w-full sm:w-auto">
					{#if passwordStatus === "saving"}
						<Loader2 class="mr-2 size-4 animate-spin" />
					{/if}
					{passwordStatus === "saved" ? m.settings_saved_status() : m.change_password()}
				</Button>
			</form>
		</Tabs.TabsContent>

		<Tabs.TabsContent value="appearance" currentValue={activeTab}>
			<div class="space-y-6">
				<div class="space-y-2">
					<Label>{m.settings_theme()}</Label>
					<p class="text-xs text-muted-foreground">{m.settings_appearance()}</p>
				</div>
				<div class="grid grid-cols-3 gap-2">
					{#each themeOptions as opt (opt.key)}
						<button
							type="button"
							onclick={() => pickTheme(opt.value)}
							class={[
								"rounded-md border px-3 py-2 text-sm font-medium transition-colors",
								themeStore.value === opt.value
									? "border-primary bg-primary text-primary-foreground"
									: "border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground",
							].join(" ")}
						>
							{opt.label}
						</button>
					{/each}
				</div>

				<details class="editor-settings border-t pt-5">
					<summary class="flex cursor-pointer items-center justify-between gap-3 rounded-md px-1 py-2">
						<span>
							<span class="block text-sm font-medium">Editor modes</span>
							<span class="block text-xs text-muted-foreground">Source views and toolbar layout</span>
						</span>
						<span class="editor-settings-chevron" aria-hidden="true">⌄</span>
					</summary>
					<div class="mt-3 space-y-3">
					<div class="flex items-center justify-between gap-4 rounded-md border p-3">
						<span>
							<span class="block text-sm font-medium">Visual editor</span>
							<span class="block text-xs text-muted-foreground">Show the standard WYSIWYG editor mode.</span>
						</span>
						<button
							type="button" role="switch" class="preference-switch"
							class:enabled={editorPreferences.showVisualMode}
							aria-checked={editorPreferences.showVisualMode}
							aria-label="Show visual editor"
							disabled={!editorPreferences.showMarkdownMode}
							onclick={() => editorPreferences.update({ showVisualMode: !editorPreferences.showVisualMode })}
						><span></span></button>
					</div>
					<div class="flex items-center justify-between gap-4 rounded-md border p-3">
						<span>
							<span class="block text-sm font-medium">Raw Markdown</span>
							<span class="block text-xs text-muted-foreground">Show the Markdown source button in documents.</span>
						</span>
						<button
							type="button" role="switch" class="preference-switch"
							class:enabled={editorPreferences.showMarkdownMode}
							aria-checked={editorPreferences.showMarkdownMode}
							aria-label="Show Raw Markdown"
							disabled={!editorPreferences.showVisualMode}
							onclick={() => editorPreferences.update({ showMarkdownMode: !editorPreferences.showMarkdownMode })}
						><span></span></button>
					</div>
					<div class="flex items-center justify-between gap-4 rounded-md border p-3">
						<span>
							<span class="block text-sm font-medium">Minimal toolbar</span>
							<span class="block text-xs text-muted-foreground">Bold, italic, underline, lists, highlight, and copy.</span>
						</span>
						<button
							type="button" role="switch" class="preference-switch"
							class:enabled={editorPreferences.minimalToolbar}
							aria-checked={editorPreferences.minimalToolbar}
							aria-label="Use minimal toolbar"
							onclick={() => editorPreferences.update({ minimalToolbar: !editorPreferences.minimalToolbar })}
						><span></span></button>
					</div>
					<div class="flex items-center justify-between gap-4 rounded-md border p-3">
						<span>
							<span class="block text-sm font-medium">Scroll to top</span>
							<span class="block text-xs text-muted-foreground">Show the floating arrow after scrolling down.</span>
						</span>
						<button
							type="button" role="switch" class="preference-switch"
							class:enabled={editorPreferences.showScrollToTop}
							aria-checked={editorPreferences.showScrollToTop}
							aria-label="Show scroll to top"
							onclick={() => editorPreferences.update({ showScrollToTop: !editorPreferences.showScrollToTop })}
						><span></span></button>
					</div>
					</div>
				</details>
			</div>
		</Tabs.TabsContent>

		<Tabs.TabsContent value="api" currentValue={activeTab}>
			<ApiAccessSettings />
		</Tabs.TabsContent>

		{#each settingsExtensions as section (section.id)}
			<Tabs.TabsContent value={section.id} currentValue={activeTab}>
				{@const Section = section.component}
				<Section />
			</Tabs.TabsContent>
		{/each}
	</Tabs.Tabs>

	<Dialog.DialogFooter class="settings-dialog-footer gap-4 max-sm:flex-col max-sm:items-stretch">
		{#if activeTab === "profile"}
			<Button
				id="logout-button"
				variant="ghost"
				onclick={handleLogout}
				disabled={loggingOut}
				class="mr-auto text-muted-foreground hover:text-destructive max-sm:mr-0"
			>
				<LogOut class="mr-2 size-4" />
				{loggingOut ? "…" : m.auth_logout()}
			</Button>
		{/if}
		<Button variant="outline" onclick={close} class="w-full sm:w-auto">{m.action_close()}</Button>
	</Dialog.DialogFooter>
</Dialog.Dialog>

<style>
	.editor-settings summary { list-style: none; }
	.editor-settings summary::-webkit-details-marker { display: none; }
	.editor-settings-chevron { font-size: 20px; transition: transform 0.18s ease; }
	.editor-settings[open] .editor-settings-chevron { transform: rotate(180deg); }
	.preference-switch {
		position: relative; flex: 0 0 auto; width: 42px; height: 24px; padding: 2px;
		border: 1px solid var(--border); border-radius: 999px; background: var(--muted);
		transition: background 0.18s ease, border-color 0.18s ease; cursor: pointer;
	}
	.preference-switch span {
		display: block; width: 18px; height: 18px; border-radius: 999px;
		background: var(--background); box-shadow: 0 1px 3px rgb(0 0 0 / 0.22);
		transition: transform 0.18s ease;
	}
	.preference-switch.enabled { border-color: var(--primary); background: var(--primary); }
	.preference-switch.enabled span { transform: translateX(18px); }
	.preference-switch:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
	.preference-switch:disabled { cursor: not-allowed; opacity: 0.45; }
</style>
