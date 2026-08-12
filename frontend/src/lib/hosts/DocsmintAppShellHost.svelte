<script lang="ts">
import { type Snippet, untrack } from "svelte";
import MobileSidebarToggle from "$lib/components/MobileSidebarToggle.svelte";
import ScrollToTop from "$lib/components/ScrollToTop.svelte";
import Sidebar from "$lib/components/sidebar/Sidebar.svelte";
import { editorPreferences } from "$lib/stores/editor-preferences.svelte";
import {
	closeMobileSidebar,
	mobileSidebar,
	openMobileSidebar,
} from "$lib/stores/mobile-sidebar.svelte";
import { createEdgeSwipeTracker } from "$lib/stores/mobile-sidebar-gesture";
import { searchPreferences } from "$lib/stores/search-preferences.svelte";
import { refreshFolders } from "$lib/stores/subfolders-refresh-store.svelte";
import { refreshDocs, refreshTags } from "$lib/stores/tag-store.svelte";
import type { DocsmintFrontendExtensions } from "../extensions/types";
import HiaiDocsExtensionProvider from "./HiaiDocsExtensionProvider.svelte";
import {
	hasMutationRefreshImpact,
	mutationRefreshImpact,
} from "./mutation-refresh";
import { provideDocsmintRealtimeAdapter } from "./realtime-context";
import {
	provideDocsmintRequestAdapter,
	provideDocsmintRouteAdapter,
} from "./route-context";
import type {
	DocsmintRealtimeAdapter,
	DocsmintRequestAdapter,
	DocsmintRouteAdapter,
} from "./types";

const {
	route,
	request = { fetch },
	realtime,
	extensions = {},
	children,
}: {
	route: DocsmintRouteAdapter;
	request?: DocsmintRequestAdapter;
	realtime?: DocsmintRealtimeAdapter;
	extensions?: Partial<DocsmintFrontendExtensions>;
	children: Snippet;
} = $props();

provideDocsmintRouteAdapter({
	get pathname() {
		return route.pathname;
	},
	resolve: (path) => route.resolve(path),
	navigate: (path, options) => route.navigate?.(path, options),
});
provideDocsmintRequestAdapter({
	fetch: (async (...args: Parameters<typeof fetch>) => {
		const response = await request.fetch(...args);
		const impact = mutationRefreshImpact(args[0], args[1]);
		if (response.ok && hasMutationRefreshImpact(impact)) {
			if (impact.documents) refreshDocs();
			if (impact.folders) refreshFolders();
			if (impact.tags) refreshTags();
		}
		return response;
	}) as typeof fetch,
});
const realtimeAdapter = untrack(() => realtime);
if (realtimeAdapter) provideDocsmintRealtimeAdapter(realtimeAdapter);

editorPreferences.init();
searchPreferences.init();

let mainElement = $state<HTMLElement | null>(null);
let sidebarElement = $state<HTMLElement | null>(null);
let toggleButton = $state<HTMLButtonElement | null>(null);
let isMobile = $state(false);
const edgeSwipe = createEdgeSwipeTracker();

function handleEdgePointerDown(event: PointerEvent) {
	edgeSwipe.start({ x: event.clientX, y: event.clientY });
	(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}

function handleEdgePointerMove(event: PointerEvent) {
	if (edgeSwipe.move({ x: event.clientX, y: event.clientY }) !== "open") return;
	event.preventDefault();
	openMobileSidebar();
}

function handleEdgePointerEnd(event: PointerEvent) {
	if (edgeSwipe.end({ x: event.clientX, y: event.clientY }) === "open") {
		openMobileSidebar();
	}
}

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

$effect(() => {
	route.pathname;
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

<HiaiDocsExtensionProvider {extensions}>
  <div class="flex h-screen" data-docsmint-app-shell-host>
    <Sidebar mobile={isMobile} mobileOpen={mobileSidebar.open} bind:element={sidebarElement} />
    <main
      id="main-content"
      bind:this={mainElement}
      inert={isMobile && mobileSidebar.open}
      class="relative flex-1 overflow-auto"
    >
      {@render children()}
    </main>
  </div>
  <MobileSidebarToggle bind:buttonRef={toggleButton} />
  {#if isMobile && !mobileSidebar.open}
    <div
      data-mobile-sidebar-edge
      aria-hidden="true"
      class="fixed inset-y-0 left-0 z-20 w-9 md:hidden"
      style="touch-action: pan-y;"
      onpointerdown={handleEdgePointerDown}
      onpointermove={handleEdgePointerMove}
      onpointerup={handleEdgePointerEnd}
      onpointercancel={() => edgeSwipe.cancel()}
    ></div>
  {/if}
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
    avoidEditorToolbar={route.pathname.startsWith('/docs/')}
  />
{/if}
