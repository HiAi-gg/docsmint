<script lang="ts">
import { Button } from "@hiai-gg/hiai-ui/components/ui/button/index";
import { RefreshCw } from "lucide-svelte";
import { onMount } from "svelte";
import { pwaDirtyState } from "$lib/stores/pwa-dirty-state.svelte";

let showUpdate = $state(false);
let waitingWorker: ServiceWorker | null = $state(null);

onMount(() => {
	if (!("serviceWorker" in navigator)) return;

	navigator.serviceWorker.ready.then((registration) => {
		// A new service worker finished installing while the page is open.
		registration.addEventListener("updatefound", () => {
			const newWorker = registration.installing;
			if (!newWorker) return;

			newWorker.addEventListener("statechange", () => {
				if (
					newWorker.state === "installed" &&
					navigator.serviceWorker.controller
				) {
					// New SW is waiting to activate — offer the update.
					waitingWorker = newWorker;
					showUpdate = true;
				}
			});
		});

		// There may already be a worker waiting from a previous load.
		if (registration.waiting) {
			waitingWorker = registration.waiting;
			showUpdate = true;
		}
	});
});

function handleUpdate() {
	if (!waitingWorker) return;
	if (pwaDirtyState.dirty) return;
	// Tell the waiting worker to skip waiting and activate immediately.
	waitingWorker.postMessage({ type: "SKIP_WAITING" });
	// Reload once the new worker takes control, so the user gets the
	// updated bundle. The user controls when this happens.
	const reload = () => {
		navigator.serviceWorker.removeEventListener("controllerchange", reload);
		window.location.reload();
	};
	navigator.serviceWorker.addEventListener("controllerchange", reload, {
		once: true,
	});
}
</script>

{#if showUpdate}
	<div class="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 md:bottom-20" role="status" aria-live="polite">
		<div class="flex items-center gap-3 rounded-lg border bg-background px-4 py-3 shadow-lg">
			<RefreshCw class="h-5 w-5 text-primary" />
			<p class="text-sm">New version available</p>
			{#if pwaDirtyState.dirty}<span class="text-xs text-muted-foreground">{pwaDirtyState.reason ?? "Save your work first"}</span>{:else}<Button size="sm" onclick={handleUpdate}>Reload</Button>{/if}
		</div>
	</div>
{/if}
