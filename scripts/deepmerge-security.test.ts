import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import deepmerge from "../vendor/deepmerge";
const require = createRequire(import.meta.url);
const original: typeof deepmerge = require("./fixtures/deepmerge-4.3.1.cjs");
const payload = (): Record<string, unknown> =>
	JSON.parse('{"__proto__":{"injected":true},"ordinary":1}');

test("original integrity-checked entrypoint reproduces prototype poisoning", () => {
	const result = original<Record<string, unknown>>(
		Object.create(null),
		payload(),
	);
	expect(Object.getPrototypeOf(result)).not.toBe(Object.prototype);
	expect(result.injected).toBe(true);
});
test("null-prototype target keeps source __proto__ as safe own data", () => {
	const target = Object.create(null);
	const source = payload();
	const result = deepmerge<Record<string, unknown>>(target, source);
	expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
	expect(Object.hasOwn(result, "__proto__")).toBe(true);
	expect(Object.getOwnPropertyDescriptor(result, "__proto__")).toMatchObject({
		enumerable: true,
		writable: true,
		configurable: true,
	});
	expect(result.injected).toBeUndefined();
	expect(result.ordinary).toBe(1);
	expect(Object.getPrototypeOf(target)).toBeNull();
	expect(Object.getPrototypeOf(source)).toBe(Object.prototype);
	expect(({} as Record<string, unknown>).injected).toBeUndefined();
});
test("copying own target __proto__ preserves the ordinary output prototype", () => {
	const result = deepmerge(payload(), { extra: 2 });
	expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
	expect(Object.hasOwn(result, "__proto__")).toBe(true);
	expect((result as Record<string, unknown>).injected).toBeUndefined();
	expect(result.extra).toBe(2);
});
test("recursive merges and custom merge callbacks remain safe and compatible", () => {
	const source = { nested: payload() };
	const result = deepmerge({ nested: Object.create(null) }, source);
	expect(Object.getPrototypeOf(result.nested)).toBe(Object.prototype);
	expect(result.nested.injected).toBeUndefined();
	const custom = deepmerge({ nested: {} }, source, {
		customMerge: (key) =>
			key === "nested" ? (_left, right) => right : undefined,
	});
	expect(Object.getPrototypeOf(custom)).toBe(Object.prototype);
	expect(custom.nested).toBe(source.nested);
});
test("arrays, merge-all, enumerable symbols and clone:false preserve the API", () => {
	const symbol = Symbol("metadata");
	const source = {
		list: [{ a: 1 }] as Array<number | { a: number }>,
		[symbol]: { b: 2 },
	};
	const result = deepmerge<typeof source>(
		{ list: [1] as Array<number | { a: number }> },
		source,
	);
	expect(result.list).toEqual([1, { a: 1 }]);
	expect(result[symbol]).toEqual({ b: 2 });
	expect(result[symbol]).not.toBe(source[symbol]);
	expect(deepmerge.all([{ a: 1 }, { b: 2 }])).toEqual({ a: 1, b: 2 });
	expect(
		deepmerge({ list: [1] as Array<number | { a: number }> }, source, {
			arrayMerge: (_left, right) => right,
		}).list,
	).toBe(source.list);
	expect(deepmerge({}, source, { clone: false }).list).toBe(source.list);
	expect(source.list).toEqual([{ a: 1 }]);
});

test("merging existing own __proto__ properties never activates a setter", () => {
	const result = deepmerge(payload(), payload());
	expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
	expect(Object.hasOwn(result, "__proto__")).toBe(true);
	expect(result.injected).toBeUndefined();
	expect(result.__proto__).toEqual({ injected: true });
});

test("both actual build dependency paths execute the patched fork", () => {
	const frontend = createRequire(
		new URL("../frontend/package.json", import.meta.url),
	);
	const sveltePlugin = frontend.resolve("@sveltejs/vite-plugin-svelte");
	const pwa = frontend.resolve("vite-plugin-pwa");
	const workbox = createRequire(pwa).resolve("workbox-build");
	const rollupResolver = createRequire(workbox).resolve(
		"@rollup/plugin-node-resolve",
	);
	for (const parent of [sveltePlugin, rollupResolver]) {
		const dependency = createRequire(parent);
		const actual: typeof deepmerge = dependency("deepmerge");
		expect(dependency("deepmerge/package.json").version).toBe(
			"4.3.2-docsmint.1",
		);
		const result = actual<Record<string, unknown>>(
			Object.create(null),
			payload(),
		);
		expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
		expect(result.injected).toBeUndefined();
		expect(Object.hasOwn(result, "__proto__")).toBe(true);
	}
});
