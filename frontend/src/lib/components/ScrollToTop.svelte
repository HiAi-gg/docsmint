<script lang="ts">
import { onMount, onDestroy } from "svelte";
import { ArrowUp } from "lucide-svelte";

const SCROLL_THRESHOLD = 300;

let visible = $state(false);
let scrollHandler: (() => void) | null = null;

function handleScroll() {
	visible = window.scrollY > SCROLL_THRESHOLD;
}

function scrollToTop() {
	window.scrollTo({ top: 0, behavior: "smooth" });
}

onMount(() => {
	handleScroll();
	scrollHandler = handleScroll;
	window.addEventListener("scroll", scrollHandler, { passive: true });
});

onDestroy(() => {
	if (scrollHandler) window.removeEventListener("scroll", scrollHandler);
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
