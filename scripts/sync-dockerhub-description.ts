type DescriptionInput = {
	username: string;
	token: string;
	description: string;
	fullDescription: string;
};
type Request = (url: string, init?: RequestInit) => Promise<Response>;
const repositoryUrl =
	"https://hub.docker.com/v2/repositories/vgalibov/docsmint";

export async function syncDockerHubDescription(
	input: DescriptionInput,
	request: Request = fetch,
): Promise<void> {
	if (!input.username || !input.token)
		throw new Error("DOCKERHUB_USERNAME and DOCKERHUB_TOKEN are required");
	if (!input.fullDescription.trim() || input.description.length > 100)
		throw new Error(
			"Docker Hub description is empty or the summary exceeds 100 characters",
		);
	async function checkedRequest(
		url: string,
		phase: string,
		init?: RequestInit,
	): Promise<Response> {
		let response: Response;
		try {
			response = await request(url, {
				...init,
				signal: AbortSignal.timeout(30_000),
				redirect: "error",
			});
		} catch {
			throw new Error(`Docker Hub ${phase} request failed`);
		}
		if (!response.ok)
			throw new Error(`Docker Hub ${phase} failed (HTTP ${response.status})`);
		return response;
	}
	const authentication = await checkedRequest(
		"https://hub.docker.com/v2/auth/token",
		"authentication",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ identifier: input.username, secret: input.token }),
		},
	);
	const session: unknown = await authentication.json().catch(() => null);
	if (
		!session ||
		typeof session !== "object" ||
		!("access_token" in session) ||
		typeof session.access_token !== "string" ||
		!session.access_token
	)
		throw new Error("Docker Hub authentication returned no token");
	await checkedRequest(repositoryUrl, "description update", {
		method: "PATCH",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${session.access_token}`,
		},
		body: JSON.stringify({
			description: input.description,
			full_description: input.fullDescription,
		}),
	});
	const response = await checkedRequest(
		repositoryUrl,
		"description verification",
	);
	const published: unknown = await response.json().catch(() => null);
	if (
		!published ||
		typeof published !== "object" ||
		!("full_description" in published) ||
		published.full_description !== input.fullDescription ||
		!("description" in published) ||
		published.description !== input.description
	)
		throw new Error("Docker Hub description readback did not match");
}

if (import.meta.main) {
	try {
		await syncDockerHubDescription({
			username: Bun.env.DOCKERHUB_USERNAME ?? "",
			token: Bun.env.DOCKERHUB_TOKEN ?? "",
			description:
				"Self-hosted knowledge workspace with AI search, a rich-text editor, REST API, SDK, CLI, and MCP.",
			fullDescription: await Bun.file(
				new URL("../docs/release/docker-hub-description.md", import.meta.url),
			).text(),
		});
		console.log(
			"Docker Hub description updated and verified: vgalibov/docsmint",
		);
	} catch (error) {
		console.error(
			error instanceof Error
				? error.message
				: "Docker Hub description sync failed",
		);
		process.exitCode = 1;
	}
}
