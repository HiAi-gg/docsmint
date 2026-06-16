<script lang="ts">
import { ArrowUp } from "lucide-svelte";
import { onDestroy } from "svelte";

const SCROLL_THRESHOLD = 300;

let { scrollTarget }: { scrollTarget?: HTMLElement | null } = $props();

let visible = $state(false);
let activeTarget: HTMLElement | null = null;

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
</script>

<button
	type="button"
	class="fixed bottom-6 right-6 z-50 inline-flex size-10 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-md transition-all hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring {visible ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}"
	aria-label="Scroll to top"
	title="Scroll to top"
	onclick={scrollToTop}
>
	<ArrowUp class="size-5" />
</button>
