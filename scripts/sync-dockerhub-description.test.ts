import { expect, test } from "bun:test";
import { syncDockerHubDescription } from "./sync-dockerhub-description";

test("authenticates, updates the committed description, and verifies public content", async () => {
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	const request = async (url: string, init?: RequestInit) => {
		calls.push({ url, init });
		return Response.json(
			calls.length === 1
				? { access_token: "session-token" }
				: {
						full_description: "# DocsMint",
						description: "Knowledge workspace",
					},
		);
	};
	await syncDockerHubDescription(
		{
			username: "maintainer",
			token: "private-token",
			fullDescription: "# DocsMint",
			description: "Knowledge workspace",
		},
		request,
	);
	expect(calls.map((c) => c.init?.method ?? "GET")).toEqual([
		"POST",
		"PATCH",
		"GET",
	]);
	expect(calls[1]?.url).toBe("https://hub.docker.com/v2/repositories/vgalibov/docsmint");
	expect(calls[2]?.url).toBe("https://hub.docker.com/v2/repositories/vgalibov/docsmint");
	expect(calls[1]?.init?.headers).toEqual({
		"Content-Type": "application/json",
		Authorization: "Bearer session-token",
	});
	expect(calls[1]?.init?.body).toBe(
		JSON.stringify({
			description: "Knowledge workspace",
			full_description: "# DocsMint",
		}),
	);
	expect(calls[2]?.init?.headers).toBeUndefined();
});

test("fails closed without exposing authentication response bodies", async () => {
	await expect(
		syncDockerHubDescription(
			{
				username: "maintainer",
				token: "private-token",
				fullDescription: "# DocsMint",
				description: "Knowledge workspace",
			},
			async () => new Response("private-token", { status: 401 }),
		),
	).rejects.toThrow("Docker Hub authentication failed (HTTP 401)");
});

test("rejects readback mismatch", async () => {
	let count = 0;
	await expect(
		syncDockerHubDescription(
			{
				username: "maintainer",
				token: "private-token",
				fullDescription: "# DocsMint",
				description: "Knowledge workspace",
			},
			async () =>
				Response.json(
					++count === 1
						? { access_token: "session" }
						: { full_description: "old" },
				),
		),
	).rejects.toThrow("Docker Hub description readback did not match");
});

test("does not attempt publication with missing credentials", async () => {
	let requested = false;
	await expect(
		syncDockerHubDescription(
			{
				username: "",
				token: "",
				description: "DocsMint",
				fullDescription: "# DocsMint",
			},
			async () => {
				requested = true;
				return Response.json({});
			},
		),
	).rejects.toThrow("DOCKERHUB_USERNAME and DOCKERHUB_TOKEN are required");
	expect(requested).toBe(false);
});

test("does not leak credentials in network failures", async () => {
	await expect(
		syncDockerHubDescription(
			{
				username: "maintainer",
				token: "private-token",
				description: "DocsMint",
				fullDescription: "# DocsMint",
			},
			async () => {
				throw new Error("private-token");
			},
		),
	).rejects.toThrow("Docker Hub authentication request failed");
});
