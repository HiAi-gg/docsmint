<script lang="ts">
import { page } from "$app/state";
import MobileSidebarToggle from "$lib/components/MobileSidebarToggle.svelte";
import ScrollToTop from "$lib/components/ScrollToTop.svelte";
import Sidebar from "$lib/components/sidebar/Sidebar.svelte";
import HiaiDocsExtensionProvider from "$lib/hosts/HiaiDocsExtensionProvider.svelte";
import { editorPreferences } from "$lib/stores/editor-preferences.svelte";
import {
	closeMobileSidebar,
	mobileSidebar,
} from "$lib/stores/mobile-sidebar.svelte";
import { searchPreferences } from "$lib/stores/search-preferences.svelte";

const { children } = $props();

editorPreferences.init();
searchPreferences.init();

let mainElement = $state<HTMLElement | null>(null);
let sidebarElement = $state<HTMLElement | null>(null);
let toggleButton = $state<HTMLButtonElement | null>(null);
let isMobile = $state(false);

const focusableSelector = [
	"a[href]",
	"button:not([disabled])",
	"input:not([disabled])",
	"select:not([disabled])",
	"textarea:not([disabled])",
	'[tabindex]:not([tabindex="-1"])',
].join(",");

$effect(() => {
	const mediaQuery = window.matchMedia("(max-width: 767px)");
	const updateViewport = () => {
		isMobile = mediaQuery.matches;
		if (!isMobile) closeMobileSidebar();
	};

	updateViewport();
	mediaQuery.addEventListener("change", updateViewport);
	return () => mediaQuery.removeEventListener("change", updateViewport);
});

// Close the mobile sheet whenever the route changes so it never stays
// open over a freshly navigated page.
$effect(() => {
	page.url.pathname;
	closeMobileSidebar();
});

$effect(() => {
	if (!isMobile || !mobileSidebar.open || !sidebarElement) return;

	const previouslyFocused =
		document.activeElement instanceof HTMLElement
			? document.activeElement
			: toggleButton;
	const previousBodyOverflow = document.body.style.overflow;
	document.body.style.overflow = "hidden";

	const focusableElements = () =>
		Array.from(
			sidebarElement?.querySelectorAll<HTMLElement>(focusableSelector) ?? [],
		).filter((element) => !element.hasAttribute("disabled"));

	const handleKeydown = (event: KeyboardEvent) => {
		const nestedDialog =
			event.target instanceof Element
				? event.target.closest<HTMLElement>('[role="dialog"]')
				: null;
		if (nestedDialog && nestedDialog !== sidebarElement) return;

		if (event.key === "Escape") {
			event.preventDefault();
			closeMobileSidebar();
			return;
		}
		if (event.key !== "Tab") return;

		const elements = focusableElements();
		const first = elements.at(0);
		const last = elements.at(-1);
		if (!first || !last) {
			event.preventDefault();
			sidebarElement?.focus();
			return;
		}

		if (event.shiftKey && document.activeElement === first) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first.focus();
		}
	};

	document.addEventListener("keydown", handleKeydown);
	const focusFrame = requestAnimationFrame(() => {
		(focusableElements().at(0) ?? sidebarElement)?.focus();
	});

	return () => {
		cancelAnimationFrame(focusFrame);
		document.removeEventListener("keydown", handleKeydown);
		document.body.style.overflow = previousBodyOverflow;
		if (previouslyFocused?.isConnected) previouslyFocused.focus();
	};
});
</script>

<HiaiDocsExtensionProvider>
	<div class="flex h-screen">
		<Sidebar
			mobile={isMobile}
			mobileOpen={mobileSidebar.open}
			bind:element={sidebarElement}
		/>

		<main
			id="main-content"
			bind:this={mainElement}
			inert={isMobile && mobileSidebar.open}
			class="relative z-0 flex-1 overflow-auto"
		>
			{@render children()}
		</main>
	</div>

	<!-- Mobile hamburger toggle (visible only < 768px). -->
	<MobileSidebarToggle bind:buttonRef={toggleButton} />

	{#if isMobile && mobileSidebar.open}
		<button
			type="button"
			tabindex="-1"
			aria-label="Close navigation menu"
			class="fixed inset-0 z-40 bg-black/50"
			onclick={closeMobileSidebar}
		></button>
	{/if}
</HiaiDocsExtensionProvider>

{#if editorPreferences.showScrollToTop}
	<ScrollToTop
		scrollTarget={mainElement}
		avoidEditorToolbar={page.url.pathname.startsWith("/docs/")}
	/>
{/if}
