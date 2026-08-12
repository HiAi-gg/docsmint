import { describe, expect, test } from "bun:test";
import { createEdgeSwipeTracker } from "./mobile-sidebar-gesture";

describe("mobile sidebar edge gesture", () => {
	test("opens after a deliberate rightward edge swipe", () => {
		const tracker = createEdgeSwipeTracker();
		tracker.start({ x: 12, y: 120 });
		expect(tracker.move({ x: 58, y: 126 })).toBe("open");
	});

	test("does not capture vertical scroll or short taps", () => {
		const tracker = createEdgeSwipeTracker();
		tracker.start({ x: 8, y: 120 });
		expect(tracker.move({ x: 18, y: 176 })).toBe("cancelled");
		tracker.start({ x: 8, y: 120 });
		expect(tracker.end({ x: 24, y: 123 })).toBe("idle");
	});

	test("ignores gestures that do not start inside the edge zone", () => {
		const tracker = createEdgeSwipeTracker({ edgeWidth: 36 });
		tracker.start({ x: 48, y: 120 });
		expect(tracker.move({ x: 120, y: 122 })).toBe("idle");
	});
});
