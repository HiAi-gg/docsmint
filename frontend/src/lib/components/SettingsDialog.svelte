<script lang="ts">
import { Loader2, LogOut, Save } from "lucide-svelte";
import { onMount } from "svelte";
import { goto } from "$app/navigation";
import { getProfile, updateProfile } from "$lib/api/settings";
import { authClient, signOut } from "$lib/auth-client";
import { Button } from "$lib/components/ui/button";
import * as Dialog from "$lib/components/ui/dialog";
import { Input } from "$lib/components/ui/input";
import { Label } from "$lib/components/ui/label";
import * as Tabs from "$lib/components/ui/tabs";
import * as m from "$lib/paraglide/messages.js";
import { type Theme, themeStore } from "$lib/stores/theme.svelte";

let {
	open = $bindable(false),
}: {
	open?: boolean;
} = $props();

let activeTab = $state("profile");

// Profile
let name = $state("");
let email = $state("");
let profileStatus = $state<"idle" | "saving" | "saved" | "error">("idle");
let profileError = $state("");

// Password
let currentPassword = $state("");
let newPassword = $state("");
let confirmPassword = $state("");
let passwordStatus = $state<"idle" | "saving" | "saved" | "error">("idle");
let passwordError = $state("");

onMount(async () => {
	try {
		const profile = await getProfile();
		if (profile.name) name = profile.name;
		if (profile.email) email = profile.email;
	} catch {
		// use defaults
	}
});

async function saveProfile() {
	profileStatus = "saving";
	profileError = "";
	try {
		await updateProfile({ name });
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
		<Tabs.TabsList class="grid w-full grid-cols-3">
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
				value="appearance"
				selected={activeTab === "appearance"}
				onclick={(v) => (activeTab = v)}
			>
				{m.settings_appearance()}
			</Tabs.TabsTrigger>
		</Tabs.TabsList>

		<Tabs.TabsContent value="profile" currentValue={activeTab}>
			<form onsubmit={(e) => { e.preventDefault(); saveProfile(); }} class="space-y-4">
				<div class="space-y-2">
					<Label for="settings-name">{m.settings_name()}</Label>
					<Input id="settings-name" type="text" name="name" bind:value={name} autocomplete="name" />
				</div>
				<div class="space-y-2">
					<Label for="settings-email">{m.settings_email()}</Label>
					<Input id="settings-email" type="email" name="email" bind:value={email} autocomplete="email" disabled />
				</div>
				{#if profileError}
					<p class="text-sm text-destructive">{profileError}</p>
				{/if}
				<Button type="submit" disabled={profileStatus === "saving"}>
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
				<Button type="submit" disabled={passwordStatus === "saving"}>
					{#if passwordStatus === "saving"}
						<Loader2 class="mr-2 size-4 animate-spin" />
					{/if}
					{passwordStatus === "saved" ? m.settings_saved_status() : m.change_password()}
				</Button>
			</form>
		</Tabs.TabsContent>

		<Tabs.TabsContent value="appearance" currentValue={activeTab}>
			<div class="space-y-4">
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
			</div>
		</Tabs.TabsContent>
	</Tabs.Tabs>

	<Dialog.DialogFooter>
		<Button
			id="logout-button"
			variant="ghost"
			onclick={handleLogout}
			disabled={loggingOut}
			class="mr-auto text-muted-foreground hover:text-destructive"
		>
			<LogOut class="mr-2 size-4" />
			{loggingOut ? "…" : m.auth_logout()}
		</Button>
		<Button variant="outline" onclick={close}>{m.action_close()}</Button>
	</Dialog.DialogFooter>
</Dialog.Dialog>
