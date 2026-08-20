<script lang="ts">
import { Button } from "@hiai-gg/hiai-ui/components/ui/button/index";
import { Card, CardContent } from "@hiai-gg/hiai-ui/components/ui/card/index";
import { Download, X } from "lucide-svelte";
import { onMount } from "svelte";

// The native `beforeinstallprompt` event is not in the standard DOM lib
// types, so we declare a minimal structural type for it.
type BeforeInstallPromptEvent = Event & {
	prompt: () => Promise<void>;
	userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

let deferredPrompt: BeforeInstallPromptEvent | null = $state(null);
let showBanner = $state(false);
let iosInstall = $state(false);

const DISMISS_KEY = "pwa_install_dismissed_at";
const DISMISS_WINDOW_MS = 24 * 60 * 60 * 1000;
const SHOW_DELAY_MS = 1500;

onMount(() => {
	// Already running as an installed PWA — never prompt.
	const isStandalone = window.matchMedia("(display-mode: standalone)").matches;
	if (isStandalone) return;
	const isIos = /iphone|ipad|ipod/i.test(window.navigator.userAgent);
	const isIosSafari =
		isIos &&
		/safari/i.test(window.navigator.userAgent) &&
		!/crios|fxios/i.test(window.navigator.userAgent);

	// Respect the 24h dismissal cooldown so the banner is shown at most
	// once per day.
	const dismissedAt = localStorage.getItem(DISMISS_KEY);
	const recentlyDismissed =
		dismissedAt && Date.now() - parseInt(dismissedAt, 10) < DISMISS_WINDOW_MS;
	if (recentlyDismissed) return;

	const onBeforeInstall = (e: Event) => {
		e.preventDefault();
		deferredPrompt = e as BeforeInstallPromptEvent;
		// The browser has explicitly confirmed that this page is installable.
		setTimeout(() => {
			showBanner = true;
		}, SHOW_DELAY_MS);
	};

	window.addEventListener("beforeinstallprompt", onBeforeInstall);
	if (isIosSafari) {
		iosInstall = true;
		setTimeout(() => {
			showBanner = true;
		}, SHOW_DELAY_MS);
	}
	return () =>
		window.removeEventListener("beforeinstallprompt", onBeforeInstall);
});

async function handleInstall() {
	if (!deferredPrompt) return;
	deferredPrompt.prompt();
	const { outcome } = await deferredPrompt.userChoice;
	if (outcome === "accepted") {
		showBanner = false;
	}
	deferredPrompt = null;
}

function handleDismiss() {
	showBanner = false;
	localStorage.setItem(DISMISS_KEY, Date.now().toString());
}
</script>

{#if showBanner}
	<div class="fixed bottom-4 left-4 right-4 z-50 md:left-auto md:right-4 md:w-96">
		<Card class="border-primary/20 bg-background shadow-lg">
			<CardContent class="p-4">
				<div class="flex items-start gap-3">
					<div class="flex-shrink-0 rounded-full bg-primary/10 p-2">
						<Download class="h-5 w-5 text-primary" />
					</div>
					<div class="flex-1">
						<p class="text-sm font-medium">Install DocsMint</p>
						<p class="mt-1 text-xs text-muted-foreground">
							{iosInstall
								? "Use Share, then Add to Home Screen."
								: "Access your documents offline and get a native app experience."}
						</p>
						<div class="mt-3 flex gap-2">
							{#if deferredPrompt}
								<Button size="sm" onclick={handleInstall}>Install</Button>
							{/if}
							<Button size="sm" variant="ghost" onclick={handleDismiss}>
								<X class="h-4 w-4" />
							</Button>
						</div>
					</div>
				</div>
			</CardContent>
		</Card>
	</div>
{/if}
