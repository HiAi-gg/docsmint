type CardKeyboardEvent = Pick<
	KeyboardEvent,
	"key" | "preventDefault" | "stopPropagation"
>;

export function handleCardNavigationKeydown(
	event: CardKeyboardEvent,
	navigate: () => void,
): void {
	if (event.key !== "Enter" && event.key !== " ") return;
	event.preventDefault();
	navigate();
}

export function stopCardMenuKeydown(event: CardKeyboardEvent): void {
	event.stopPropagation();
}
