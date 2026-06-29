// dndzone.ts — Hydration-safe wrapper around `svelte-dnd-action`.
//
// Background:
// `svelte-dnd-action` injects three elements into `document.body` the first
// time any `dndzone` action runs (aria instructions + a live region for
// screen-reader announcements). The library prepends them via
// `document.body.prepend(...)`, which runs synchronously inside the action.
//
// In SvelteKit pages, the Sidebar's `FolderTree` / `FolderNode` mount a
// `dndzone` during the very first paint. Svelte's hydration walker is
// walking the body at that exact moment, so the three prepended nodes
// confuse the walker and the hydration aborts with:
//
//   HierarchyRequestError: Failed to execute 'appendChild' on 'Node':
//   This node has no children
//
// The visible symptom is that the EditorToolbar's dropdown items (Bullet
// list, Align left, …) lose their reactive `onclick` bindings — the page
// hydrates far enough to render the toolbar but stops before reaching the
// child component, so the dropdowns are inert.
//
// Fix: defer the actual `dndzone` setup by one microtask. Svelte's
// hydration is synchronous, so by the time the microtask runs the walker
// has already finished attaching listeners to every node in the SSR
// tree. The dnd zone then activates a fraction of a millisecond later
// than it would otherwise, which is imperceptible.
//
// Importers (currently `FolderTree.svelte` and `FolderNode.svelte`)
// switch from `svelte-dnd-action` to `$lib/utils/dndzone` so they get the
// deferred behaviour. No `vite.config.ts` alias is involved, which means
// this file is free to import the original library without risk of an
// import cycle.

import type { ActionReturn } from "svelte/action";
import type {
	DndEvent,
	DndZoneAttributes,
	Item,
	Options,
} from "svelte-dnd-action";
import { dndzone as originalDndzone } from "svelte-dnd-action";

export type { DndEvent, Item, Options };

/**
 * Hydration-safe `dndzone` action. Defers the real setup to a microtask so
 * the library's `document.body.prepend(...)` aria injection runs *after*
 * Svelte has finished hydrating the page, not during.
 */
export function dndzone<T extends Item>(
	node: HTMLElement,
	options: Options<T>,
): ActionReturn<Options<T>, DndZoneAttributes<T>> {
	// Capture the original options so the deferred call uses the values
	// that were passed at mount time, not whatever a later `update(...)`
	// races to set.
	const initialOptions = options;
	let real: { update: (o: Options<T>) => void; destroy: () => void } | null =
		null;
	let pendingUpdate: Options<T> | null = null;
	let pendingDestroy = false;
	let scheduled = false;

	const schedule = () => {
		if (scheduled) return;
		scheduled = true;
		// `queueMicrotask` runs after the current synchronous code (the
		// hydration walker) finishes, but before the next macrotask / paint.
		// Falling back to a resolved promise keeps the behaviour identical
		// in environments without `queueMicrotask`.
		const microtask: (fn: () => void) => void =
			typeof queueMicrotask === "function"
				? queueMicrotask
				: (fn) => Promise.resolve().then(fn);
		microtask(init);
	};

	const init = () => {
		if (pendingDestroy) return;
		real = originalDndzone<T>(node, initialOptions) as unknown as {
			update: (o: Options<T>) => void;
			destroy: () => void;
		};
		if (pendingUpdate) {
			real.update(pendingUpdate);
			pendingUpdate = null;
		}
	};

	// Start the deferred initialisation. The microtask runs after the
	// current synchronous work (hydration walker) finishes but before
	// the next paint, so the aria injection into `document.body` happens
	// *after* Svelte has attached all its listeners and won't confuse
	// the walker.
	schedule();

	return {
		update(newOptions) {
			if (real) {
				real.update(newOptions);
			} else {
				pendingUpdate = newOptions;
				schedule();
			}
		},
		destroy() {
			if (real) {
				real.destroy();
				real = null;
			} else {
				pendingDestroy = true;
			}
		},
	};
}
