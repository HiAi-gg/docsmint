type FocusTarget = { isConnected: boolean; focus(): void };

/** Wait for the closing render: modal chrome may recreate the trigger node. */
export function restoreMobileSidebarFocus(
	previous: FocusTarget | null,
	getToggle: () => FocusTarget | null,
	isOpen: () => boolean,
	schedule: (callback: () => void) => unknown = requestAnimationFrame,
): void {
	schedule(() => {
		if (isOpen()) return;
		const target = previous?.isConnected ? previous : getToggle();
		if (target?.isConnected) target.focus();
	});
}
