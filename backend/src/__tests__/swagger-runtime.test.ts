import { describe, expect, test } from "bun:test";
import { swagger } from "@elysiajs/swagger";
import { Elysia } from "elysia";

describe("published API documentation runtime", () => {
	test("starts with patched Zod and serves the existing docs and JSON routes", async () => {
		const app = new Elysia()
			.use(
				swagger({
					path: "/api/docs",
					documentation: {
						info: { title: "Synthetic API", version: "fixture" },
					},
				}),
			)
			.get("/fixture", () => "ok");
		expect(
			(await app.handle(new Request("http://localhost/api/docs"))).status,
		).toBe(200);
		const response = await app.handle(
			new Request("http://localhost/api/docs/json"),
		);
		expect(response.status).toBe(200);
		const schema = await response.json();
		expect(schema.paths["/fixture"]).toBeDefined();
	});
});
