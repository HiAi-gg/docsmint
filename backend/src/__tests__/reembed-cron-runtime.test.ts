import { describe, expect, test } from "bun:test";
import { createCronTimerRegistry } from "../lib/cron-timer-registry";

describe("reembed cron timer lifecycle", () => {
	test("closes every registered interval exactly once", () => {
		const cleared: number[] = [];
		const registry = createCronTimerRegistry((handle) => {
			cleared.push(handle as unknown as number);
		});
		registry.register(11 as unknown as ReturnType<typeof setInterval>);
		registry.register(12 as unknown as ReturnType<typeof setInterval>);

		registry.close();
		registry.close();

		expect(cleared).toEqual([11, 12]);
	});
});
