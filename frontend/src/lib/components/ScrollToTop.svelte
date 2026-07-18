<script lang="ts">
import { ArrowUp } from "lucide-svelte";
import { onDestroy } from "svelte";
import * as m from "$lib/paraglide/messages.js";

const SCROLL_THRESHOLD = 300;

let {
	scrollTarget,
	avoidEditorToolbar = false,
}: {
	scrollTarget?: HTMLElement | null;
	avoidEditorToolbar?: boolean;
} = $props();

let visible = $state(false);
let activeTarget: HTMLElement | null = null;
let editorDock = $state<"none" | "fab" | "toolbar">("none");
let editorDockBottom = $state<string | undefined>(undefined);

const SCROLL_BUTTON_SIZE_PX = 40;
const EDITOR_DOCK_GAP_PX = 12;

function handleScroll() {
	visible =
		(activeTarget ? activeTarget.scrollTop : window.scrollY) > SCROLL_THRESHOLD;
}

function scrollToTop() {
	if (activeTarget) {
		activeTarget.scrollTo({ top: 0, behavior: "smooth" });
	} else {
		window.scrollTo({ top: 0, behavior: "smooth" });
	}
}

function attach(target: HTMLElement | null | undefined) {
	detach();
	if (!target) return;
	activeTarget = target;
	target.addEventListener("scroll", handleScroll, { passive: true });
	handleScroll();
}

function detach() {
	if (activeTarget) {
		activeTarget.removeEventListener("scroll", handleScroll);
	}
	activeTarget = null;
}

// React to changes in scrollTarget so we always listen on the right element.
// When scrollTarget is undefined, fall back to window-level scroll.
$effect(() => {
	const target = scrollTarget;
	attach(target);
	if (!target) {
		window.addEventListener("scroll", handleScroll, { passive: true });
		handleScroll();
		return () => {
			window.removeEventListener("scroll", handleScroll);
		};
	}
	return () => {
		detach();
	};
});

onDestroy(() => {
	detach();
	visible = false;
});

// Follow the actual floating editor control instead of reserving a fixed
// fraction of the screen. With the collapsed FAB the arrow sits below it;
// with an expanded toolbar it sits immediately above the toolbar. A compact
// toolbar has a smaller measured height, so the arrow naturally moves lower.
$effect(() => {
	if (!avoidEditorToolbar || typeof document === "undefined") {
		editorDock = "none";
		editorDockBottom = undefined;
		return;
	}
	const updateEditorDockPosition = () => {
		const toolbar = document.querySelector<HTMLElement>(
			".toolbar.floating-bar",
		);
		if (toolbar) {
			const rect = toolbar.getBoundingClientRect();
			editorDock = "toolbar";
			editorDockBottom = `${Math.max(
				0,
				window.innerHeight - rect.top + EDITOR_DOCK_GAP_PX,
			)}px`;
			return;
		}

		const fab = document.querySelector<HTMLElement>(".floating-fab");
		if (fab) {
			const rect = fab.getBoundingClientRect();
			editorDock = "fab";
			editorDockBottom = `${Math.max(
				EDITOR_DOCK_GAP_PX,
				window.innerHeight -
					rect.bottom -
					EDITOR_DOCK_GAP_PX -
					SCROLL_BUTTON_SIZE_PX,
			)}px`;
			return;
		}

		editorDock = "none";
		editorDockBottom = undefined;
	};
	const observer = new MutationObserver(updateEditorDockPosition);
	observer.observe(document.body, {
		childList: true,
		subtree: true,
		attributes: true,
		attributeFilter: ["class"],
	});
	const resizeObserver = new ResizeObserver(updateEditorDockPosition);
	resizeObserver.observe(document.body);
	window.addEventListener("resize", updateEditorDockPosition, {
		passive: true,
	});
	updateEditorDockPosition();
	return () => {
		observer.disconnect();
		resizeObserver.disconnect();
		window.removeEventListener("resize", updateEditorDockPosition);
	};
});
</script>

<button
	type="button"
	class:above-editor-toolbar={editorDock === "toolbar"}
	class:below-editor-fab={editorDock === "fab"}
	class="scroll-to-top fixed bottom-6 right-6 z-50 inline-flex size-10 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-md transition-all hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring {visible ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}"
	style:bottom={editorDockBottom}
	aria-label={m.scroll_to_top_aria()}
	title={m.scroll_to_top_aria()}
	onclick={scrollToTop}
>
	<ArrowUp class="size-5" />
</button>
