import { beforeAll, describe, expect, it } from "bun:test";
import { request, setupHarness } from "./_harness";

let app: Awaited<ReturnType<typeof setupHarness>>["app"];

beforeAll(async () => {
	app = (await setupHarness()).app;
});

describe("POST /api/webhooks/storage body limits", () => {
	it("returns 413 for an oversized body without a Content-Length header", async () => {
		const oversizedBody = "x".repeat(1024 * 1024 + 1);
		const res = await request(app, "/api/webhooks/storage", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-storage-signature": "a".repeat(64),
			},
			body: oversizedBody,
		});

		expect(res.status).toBe(413);
		expect(res.body).toEqual({ error: "Webhook body too large (max 1MB)" });
	});
});
