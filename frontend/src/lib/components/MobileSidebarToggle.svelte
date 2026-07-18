<script lang="ts">
import { Menu } from "lucide-svelte";
import { mobileSidebar } from "$lib/stores/mobile-sidebar.svelte";

let {
	buttonRef = $bindable(null),
	controls = "mobile-navigation",
}: {
	buttonRef?: HTMLButtonElement | null;
	controls?: string;
} = $props();

let modalOpen = $state(false);

function updateModalState() {
	// Dialog panels from the shared UI package can be mounted inside a local
	// stacking context. Hide persistent navigation chrome whenever a modal is
	// active instead of relying on a z-index comparison across those contexts.
	const dialogs = Array.from(
		document.querySelectorAll<HTMLElement>(
			'[role="dialog"][aria-modal="true"]',
		),
	);
	modalOpen = dialogs.length > 0;
	document.documentElement.classList.toggle(
		"nested-sidebar-modal-open",
		dialogs.some((dialog) => dialog.tagName !== "ASIDE"),
	);
}

$effect(() => {
	if (typeof document === "undefined") return;
	const observer = new MutationObserver(updateModalState);
	observer.observe(document.body, {
		childList: true,
		subtree: true,
		attributes: true,
		attributeFilter: ["role", "aria-modal"],
	});
	updateModalState();
	return () => {
		observer.disconnect();
		document.documentElement.classList.remove("nested-sidebar-modal-open");
	};
});

function handleClick() {
	mobileSidebar.toggle();
}
</script>

<!-- Hamburger toggle: only visible below the md (768px) breakpoint.
     Sits above main content (z-0) but below the sheet overlay (z-40) and
     sheet content (z-50). Touch target is 44x44px (size-11). -->
{#if !modalOpen}
	<button
		bind:this={buttonRef}
		type="button"
		onclick={handleClick}
		aria-label={mobileSidebar.open
			? "Close navigation menu"
			: "Open navigation menu"}
		aria-expanded={mobileSidebar.open}
		aria-controls={controls}
		class="mobile-sidebar-toggle fixed left-3 top-3 flex size-11 items-center justify-center rounded-md border border-border bg-background text-foreground shadow-sm transition-colors hover:bg-accent md:hidden"
		style="top: calc(0.75rem + env(safe-area-inset-top));"
	>
		<Menu class="size-5" />
	</button>
{/if}
