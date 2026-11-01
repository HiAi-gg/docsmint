import { expect, test } from "bun:test";
import { envSchema } from "../lib/config-schema";

test("Compose may omit the trusted public URL while independently disabling HTTP MCP", () => {
	const config = envSchema.parse({
		PUBLIC_APP_URL: "",
		MCP_HTTP_ENABLED: "false",
	});
	expect(config.PUBLIC_APP_URL).toBeUndefined();
	expect(config.MCP_HTTP_ENABLED).toBe(false);
});
test("trusted public links accept only configured HTTP origins", () => {
	expect(
		envSchema.safeParse({ PUBLIC_APP_URL: "javascript:alert(1)" }).success,
	).toBe(false);
	expect(
		envSchema.parse({ PUBLIC_APP_URL: "https://docs.example.invalid" })
			.PUBLIC_APP_URL,
	).toBe("https://docs.example.invalid");
});
