export type SwipePoint = { x: number; y: number };
export type SwipeResult = "idle" | "tracking" | "cancelled" | "open";

export function createEdgeSwipeTracker(
	options: {
		edgeWidth?: number;
		openDistance?: number;
		scrollTolerance?: number;
	} = {},
) {
	const edgeWidth = options.edgeWidth ?? 36;
	const openDistance = options.openDistance ?? 40;
	const scrollTolerance = options.scrollTolerance ?? 12;
	let startPoint: SwipePoint | null = null;
	let cancelled = false;

	return {
		start(point: SwipePoint): SwipeResult {
			startPoint = point.x <= edgeWidth ? point : null;
			cancelled = false;
			return startPoint ? "tracking" : "idle";
		},
		move(point: SwipePoint): SwipeResult {
			if (!startPoint || cancelled) return cancelled ? "cancelled" : "idle";
			const deltaX = point.x - startPoint.x;
			const deltaY = Math.abs(point.y - startPoint.y);
			if (deltaY > scrollTolerance && deltaY > Math.abs(deltaX)) {
				cancelled = true;
				return "cancelled";
			}
			if (
				deltaX >= openDistance &&
				deltaY <= Math.max(scrollTolerance * 2, deltaX)
			) {
				startPoint = null;
				return "open";
			}
			return "tracking";
		},
		end(point: SwipePoint): SwipeResult {
			const result = this.move(point);
			startPoint = null;
			cancelled = false;
			return result === "open" ? "open" : "idle";
		},
		cancel(): void {
			startPoint = null;
			cancelled = false;
		},
	};
}
