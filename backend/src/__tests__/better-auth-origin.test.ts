import { describe, expect, test } from "bun:test";

describe("Better Auth origin protection", () => {
	test("rejects a cross-origin sign-in before authentication storage is accessed", async () => {
		const script = `
			import { auth } from "./src/lib/auth.ts";
			const response = await auth.handler(new Request(
				"http://localhost:50700/api/auth/sign-in/email",
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						cookie: "better-auth.session_token=forged-session",
						origin: "https://attacker.example"
					},
					body: JSON.stringify({ email: "victim@example.com", password: "password-123" })
				}
			));
			console.log("AUTH_RESULT=" + JSON.stringify({ status: response.status, body: await response.json() }));
		`;
		const result = Bun.spawnSync({
			cmd: ["bun", "-e", script],
			cwd: import.meta.dir.replace(/\/src\/__tests__$/, ""),
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode).toBe(0);
		const resultLine = result.stdout
			.toString()
			.split("\n")
			.find((line) => line.startsWith("AUTH_RESULT="));
		expect(resultLine).toBeDefined();
		const outcome = JSON.parse(
			resultLine?.slice("AUTH_RESULT=".length) ?? "{}",
		) as {
			status?: number;
			body?: { code?: string };
		};
		expect(outcome.status).toBe(403);
		expect(outcome.body?.code).toBe("INVALID_ORIGIN");
	}, 15_000);
});
