import { describe, expect, test } from "bun:test";
import {
	handleCardNavigationKeydown,
	stopCardMenuKeydown,
} from "./card-keyboard";

describe("card keyboard behavior", () => {
	test("navigates cards for Enter while menu key events do not bubble", () => {
		let navigated = 0;
		let defaultPrevented = false;
		let bubbled = true;
		const event = {
			key: "Enter",
			preventDefault: () => {
				defaultPrevented = true;
			},
			stopPropagation: () => {
				bubbled = false;
			},
		};

		handleCardNavigationKeydown(event, () => {
			navigated += 1;
		});
		stopCardMenuKeydown(event);

		expect(navigated).toBe(1);
		expect(defaultPrevented).toBe(true);
		expect(bubbled).toBe(false);
	});
});
