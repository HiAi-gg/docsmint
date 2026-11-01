import { expect, test } from "bun:test";
import { restoreMobileSidebarFocus } from "./mobile-sidebar-focus";

test("restores the replacement toggle after the closing render", () => {
	let previousCalls = 0;
	let replacementCalls = 0;
	let toggle: { isConnected: boolean; focus(): void } | null = null;
	let pending: (() => void) | undefined;
	restoreMobileSidebarFocus(
		{
			isConnected: false,
			focus() {
				previousCalls++;
			},
		},
		() => toggle,
		() => false,
		(callback) => {
			pending = callback;
		},
	);
	expect(replacementCalls).toBe(0);
	toggle = {
		isConnected: true,
		focus() {
			replacementCalls++;
		},
	};
	pending?.();
	expect(previousCalls).toBe(0);
	expect(replacementCalls).toBe(1);
});

test("restores an existing previous target and skips a reopened or removed drawer", () => {
	let calls = 0;
	const previous = {
		isConnected: true,
		focus() {
			calls++;
		},
	};
	const immediate = (callback: () => void) => callback();
	restoreMobileSidebarFocus(
		previous,
		() => null,
		() => false,
		immediate,
	);
	expect(calls).toBe(1);
	restoreMobileSidebarFocus(
		previous,
		() => null,
		() => true,
		immediate,
	);
	expect(calls).toBe(1);
	previous.isConnected = false;
	restoreMobileSidebarFocus(
		previous,
		() => null,
		() => false,
		immediate,
	);
	expect(calls).toBe(1);
});
